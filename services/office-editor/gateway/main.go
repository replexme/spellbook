package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPublicPort     = 9980
	defaultInternalPort   = 9981
	defaultStartupTimeout = 150 * time.Second
)

var dynamicAssetNames = map[string]struct{}{
	"TaskWorker.js":                  {},
	"admin-bundle.js":                {},
	"admin.html":                     {},
	"adminAnalytics.html":            {},
	"adminAudit.html":                {},
	"adminClusterOverview.html":      {},
	"adminClusterOverviewAbout.html": {},
	"adminHistory.html":              {},
	"adminIntegratorSettings.html":   {},
	"adminLog.html":                  {},
	"adminSettings.html":             {},
	"cool.html":                      {},
	"help-localizations.json":        {},
	"localizations.json":             {},
	"uno-localizations.json":         {},
	"welcome.html":                   {},
}

type containmentState struct {
	mu       sync.RWMutex
	secure   bool
	insecure bool
}

func (s *containmentState) observe(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	lowerLine := strings.ToLower(line)
	if strings.Contains(lowerLine, "adms_contained=uncontained") ||
		strings.Contains(lowerLine, "running without chroot/namespaces/landlock") ||
		strings.Contains(lowerLine, "security warning: running without chroot jails is insecure") {
		s.insecure = true
		s.secure = false
		return
	}
	if strings.Contains(lowerLine, "adms_contained=ok") && strings.Contains(lowerLine, "adms_seccomp=ok") {
		s.secure = true
	}
}

func (s *containmentState) status() (secure, insecure bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.secure, s.insecure
}

type gateway struct {
	assetRoot    string
	assetVersion string
	upstream     *httputil.ReverseProxy
	healthClient *http.Client
	healthURL    string
	containment  *containmentState
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.LUTC)
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if err := runHealthcheck(envString("SPELLBOOK_OFFICE_HEALTH_URL", "http://127.0.0.1:9980/readyz")); err != nil {
			log.Printf("event=healthcheck_failed error=%q", err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		log.Printf("event=gateway_exit error=%q", err)
		os.Exit(1)
	}
}

func runHealthcheck(target string) error {
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(target)
	if err != nil {
		return fmt.Errorf("request readiness endpoint: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness endpoint returned %s", response.Status)
	}
	return nil
}

func run() error {
	publicPort := envInt("PORT", defaultPublicPort)
	internalPort := envInt("SPELLBOOK_OFFICE_INTERNAL_PORT", defaultInternalPort)
	startupTimeout := envDuration("SPELLBOOK_OFFICE_STARTUP_TIMEOUT", defaultStartupTimeout)
	assetRoot := envString("SPELLBOOK_OFFICE_ASSET_ROOT", "/usr/share/coolwsd/browser/dist")
	fileServerRoot := envString("SPELLBOOK_OFFICE_FILE_SERVER_ROOT", "/opt/spellbook/coolwsd")

	containment := &containmentState{}
	child, output, err := startOffice(internalPort, fileServerRoot)
	if err != nil {
		return err
	}
	log.Printf("event=office_process_started pid=%d internal_port=%d", child.Process.Pid, internalPort)

	childDone := make(chan error, 1)
	outputDone := make(chan struct{})
	securityFailure := make(chan error, 1)
	go observeOfficeOutput(output, containment, outputDone, securityFailure)
	go func() {
		err := child.Wait()
		_ = output.Close()
		childDone <- err
	}()

	upstreamURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", internalPort))
	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		log.Printf("event=upstream_error error=%q", proxyErr)
		http.Error(w, "office editor is starting", http.StatusServiceUnavailable)
	}
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalHost := request.Host
		originalDirector(request)
		request.Host = originalHost
		if request.Header.Get("X-Forwarded-Proto") == "" {
			request.Header.Set("X-Forwarded-Proto", envString("SPELLBOOK_OFFICE_FORWARDED_PROTO", "http"))
		}
	}

	handler := &gateway{
		assetRoot:    assetRoot,
		assetVersion: envString("SPELLBOOK_ASSET_VERSION", "spellbook-office"),
		upstream:     proxy,
		healthClient: &http.Client{Timeout: time.Second},
		healthURL:    fmt.Sprintf("http://127.0.0.1:%d/readyz", internalPort),
		containment:  containment,
	}
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", publicPort),
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	serverDone := make(chan error, 1)
	go func() {
		log.Printf("event=gateway_listening public_port=%d", publicPort)
		serverDone <- server.ListenAndServe()
	}()

	signalContext, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	startupFailure := make(chan error, 1)
	startupTimer := time.AfterFunc(startupTimeout, func() {
		secure, _ := containment.status()
		if !secure {
			startupFailure <- fmt.Errorf("secure office kit was not ready within %s", startupTimeout)
		}
	})
	defer startupTimer.Stop()

	var terminalErr error
	select {
	case <-signalContext.Done():
		log.Printf("event=shutdown_requested")
	case err := <-childDone:
		terminalErr = fmt.Errorf("coolwsd exited: %w", err)
	case err := <-serverDone:
		if !errors.Is(err, http.ErrServerClosed) {
			terminalErr = fmt.Errorf("gateway server exited: %w", err)
		}
	case err := <-securityFailure:
		terminalErr = err
	case err := <-startupFailure:
		terminalErr = err
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelShutdown()
	_ = server.Shutdown(shutdownContext)
	if child.ProcessState == nil || !child.ProcessState.Exited() {
		_ = child.Process.Signal(syscall.SIGTERM)
		select {
		case <-childDone:
		case <-time.After(15 * time.Second):
			_ = child.Process.Kill()
		}
	}
	select {
	case <-outputDone:
	case <-time.After(time.Second):
	}
	return terminalErr
}

func startOffice(internalPort int, fileServerRoot string) (*exec.Cmd, *io.PipeReader, error) {
	arguments := []string{
		"--use-env-vars",
		fmt.Sprintf("--port=%d", internalPort),
		"--o:sys_template_path=/opt/cool/systemplate",
		"--o:child_root_path=/tmp/spellbook-child-roots",
		"--o:file_server_root_path=" + fileServerRoot,
		"--o:cache_files.path=/tmp/spellbook-cache",
		"--o:net.listen=loopback",
		"--o:net.proto=IPv4",
		"--o:logging.color=false",
		"--o:logging.level_startup=trace",
		"--o:stop_on_config_change=true",
	}
	command := exec.Command("/usr/bin/coolwsd", arguments...)
	reader, writer := io.Pipe()
	command.Stdout = writer
	command.Stderr = writer
	command.Env = append(os.Environ(), "COOL_TRACE_STARTUP=1")
	if err := command.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, nil, fmt.Errorf("start coolwsd: %w", err)
	}
	return command, reader, nil
}

func observeOfficeOutput(reader io.Reader, state *containmentState, done chan<- struct{}, securityFailure chan<- error) {
	defer close(done)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	insecureReported := false
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Fprintln(os.Stdout, line)
		state.observe(line)
		_, insecure := state.status()
		if insecure && !insecureReported {
			insecureReported = true
			log.Printf("event=insecure_office_kit_detected action=terminate")
			securityFailure <- errors.New("Collabora started an uncontained office kit")
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		log.Printf("event=office_log_error error=%q", err)
	}
}

func (g *gateway) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/readyz":
		g.serveReady(response, request)
		return
	case "/livez":
		g.upstream.ServeHTTP(response, request)
		return
	}
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) && g.serveStatic(response, request) {
		return
	}
	g.upstream.ServeHTTP(response, request)
}

func (g *gateway) serveReady(response http.ResponseWriter, request *http.Request) {
	secure, insecure := g.containment.status()
	if insecure {
		http.Error(response, "office kit containment failed", http.StatusInternalServerError)
		return
	}
	if !secure {
		http.Error(response, "secure office kit is starting", http.StatusServiceUnavailable)
		return
	}
	probe, err := http.NewRequestWithContext(request.Context(), http.MethodGet, g.healthURL, nil)
	if err != nil {
		http.Error(response, "invalid office readiness probe", http.StatusInternalServerError)
		return
	}
	upstreamResponse, err := g.healthClient.Do(probe)
	if err != nil {
		http.Error(response, "office editor is starting", http.StatusServiceUnavailable)
		return
	}
	defer upstreamResponse.Body.Close()
	if upstreamResponse.StatusCode != http.StatusOK {
		http.Error(response, "office editor is starting", http.StatusServiceUnavailable)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(response, "ok")
}

func (g *gateway) serveStatic(response http.ResponseWriter, request *http.Request) bool {
	relative, version, ok := browserAssetPath(request.URL.Path)
	if !ok || isDynamicAsset(relative) {
		return false
	}
	rawPath := filepath.Join(g.assetRoot, filepath.FromSlash(relative))
	if !pathWithin(g.assetRoot, rawPath) {
		http.NotFound(response, request)
		return true
	}
	rawInfo, err := os.Stat(rawPath)
	if err != nil || !rawInfo.Mode().IsRegular() {
		return false
	}

	servedPath := rawPath
	contentEncoding := ""
	if acceptsEncoding(request.Header.Get("Accept-Encoding"), "gzip") {
		if gzipInfo, gzipErr := os.Stat(rawPath + ".gz"); gzipErr == nil && gzipInfo.Mode().IsRegular() {
			servedPath = rawPath + ".gz"
			contentEncoding = "gzip"
		}
	}
	file, err := os.Open(servedPath)
	if err != nil {
		return false
	}
	defer file.Close()
	servedInfo, err := file.Stat()
	if err != nil {
		return false
	}

	contentType := contentTypeFor(relative)
	if contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	if contentEncoding != "" {
		response.Header().Set("Content-Encoding", contentEncoding)
	}
	response.Header().Set("Vary", "Accept-Encoding")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	if relative == "spellbook-host.css" || relative == "spellbook-host.js" {
		response.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	} else {
		response.Header().Set("Cache-Control", "public, max-age=11059200, immutable")
	}
	etagVersion := version + ":" + g.assetVersion
	etag := strconv.Quote(etagVersion + ":" + relative + ":" + strconv.FormatInt(servedInfo.Size(), 10))
	response.Header().Set("ETag", etag)
	if request.Header.Get("If-None-Match") == etag {
		response.WriteHeader(http.StatusNotModified)
		return true
	}
	if strings.HasSuffix(strings.ToLower(relative), ".wasm") {
		response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		response.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		response.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	}
	http.ServeContent(response, request, path.Base(relative), rawInfo.ModTime(), file)
	return true
}

func browserAssetPath(requestPath string) (relative, version string, ok bool) {
	cleaned := path.Clean("/" + strings.TrimPrefix(requestPath, "/"))
	if !strings.HasPrefix(cleaned, "/browser/") {
		return "", "", false
	}
	remainder := strings.TrimPrefix(cleaned, "/browser/")
	parts := strings.SplitN(remainder, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	if strings.Contains(parts[1], "\\") {
		return "", "", false
	}
	return parts[1], parts[0], true
}

func isDynamicAsset(relative string) bool {
	_, found := dynamicAssetNames[path.Base(relative)]
	return found
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func acceptsEncoding(header, encoding string) bool {
	for _, entry := range strings.Split(header, ",") {
		name := strings.TrimSpace(strings.SplitN(entry, ";", 2)[0])
		if strings.EqualFold(name, encoding) || name == "*" {
			return true
		}
	}
	return false
}

func contentTypeFor(fileName string) string {
	extension := strings.ToLower(path.Ext(fileName))
	types := map[string]string{
		".css":   "text/css; charset=utf-8",
		".gif":   "image/gif",
		".html":  "text/html; charset=utf-8",
		".ico":   "image/x-icon",
		".jpeg":  "image/jpeg",
		".jpg":   "image/jpeg",
		".js":    "application/javascript; charset=utf-8",
		".json":  "application/json; charset=utf-8",
		".map":   "application/json; charset=utf-8",
		".png":   "image/png",
		".svg":   "image/svg+xml",
		".ttf":   "font/ttf",
		".wasm":  "application/wasm",
		".webp":  "image/webp",
		".woff":  "font/woff",
		".woff2": "font/woff2",
		".xml":   "application/xml; charset=utf-8",
	}
	if value := types[extension]; value != "" {
		return value
	}
	return mime.TypeByExtension(extension)
}

func envString(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
