using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Spellbook.Document.Core;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<LocalObjectStore>();
// The document engine's programs read, check and draw documents; without one, its format is off.
if (PptxDocumentFormatAdapter.ConfiguredEngine() is { } pptxEngine)
    builder.Services.AddSingleton<IDocumentFormatAdapter>(
        new PptxDocumentFormatAdapter(new PptxSafetyScanner(), new EngineProgram(pptxEngine, "pptx")));
if (IdmlDocumentFormatAdapter.ConfiguredEngine() is { } idmlEngine)
    builder.Services.AddSingleton<IDocumentFormatAdapter>(new IdmlDocumentFormatAdapter(idmlEngine));
builder.Services.AddHttpClient();

var app = builder.Build();
var activeJobs = new ConcurrentDictionary<string, byte>();

app.MapGet("/health", (IEnumerable<IDocumentFormatAdapter> adapters) => Results.Ok(new
{
    status = "ok",
    renderer = new { name = "Present", version = EngineProgram.Version },
    formats = adapters.Select(adapter => adapter.FormatId).ToArray()
}));

app.MapPost("/internal/jobs/scan-render", (
    HttpRequest request,
    ScanRenderJob job,
    LocalObjectStore storage,
    IEnumerable<IDocumentFormatAdapter> adapters,
    IHttpClientFactory clients) =>
{
    Authorize(request);
    AcceptJob(activeJobs, job.JobId, () => ExecuteJob(job.JobId, job.CallbackUrl, clients, storage, job.OutputPrefix, async cancellationToken =>
    {
        var adapter = RequireAdapter(adapters, job.FormatId);
        using var workspace = new JobWorkspace(job.JobId);
        var inputPath = Path.Combine(workspace.Path, $"source{adapter.FileExtension}");
        await storage.DownloadAsync(job.InputObject, inputPath, cancellationToken);
        // A save is checked against the version it was edited from.
        string? baselinePath = null;
        if (!string.IsNullOrWhiteSpace(job.BaselineInputObject))
        {
            baselinePath = Path.Combine(workspace.Path, $"baseline{adapter.FileExtension}");
            await storage.DownloadAsync(job.BaselineInputObject, baselinePath, cancellationToken);
        }
        WorkerFailure.RejectCompoundFile(inputPath);
        string? validationObject = null;
        PackageChangeBudgetReport? validation = null;
        if (baselinePath is not null)
        {
            if (job.ChangeBudget is null)
                throw new InvalidDataException("native_change_budget_missing");
            if (job.ChangeOrigin is not ("ai" or "human"))
                throw new InvalidDataException("native_change_origin_missing");
            if (job.ChangeOrigin == "ai"
                && (job.ChangeTaskIds is null
                    || job.ChangeTaskIds.Count == 0
                    || job.ChangeBudget.TargetSlideIndexes is null
                    || job.ChangeBudget.TargetSlideIndexes.Count == 0))
                throw new InvalidDataException("native_ai_change_evidence_missing");
            validation = adapter is IPackageChangeValidator own
                ? own.Validate(baselinePath, inputPath)
                : new PptxPackageChangeBudgetValidator().Validate(baselinePath, inputPath, job.ChangeBudget);
            validationObject = $"{job.OutputPrefix}/validation.json";
            await storage.UploadJsonAsync(
                validationObject,
                validation,
                DocumentJsonContext.Default.PackageChangeBudgetReport,
                cancellationToken);
            if (!validation.Valid)
                throw new ChangeBudgetExceededException(
                    validationObject,
                    validation.CandidateDocumentSha256);
        }
        var scan = adapter.Scan(inputPath);
        var graph = adapter.Inspect(inputPath, scan);
        // Every page is drawn: the engine draws a whole deck in about a second.
        var images = await adapter.RenderAsync(inputPath, Path.Combine(workspace.Path, "slides"), cancellationToken);
        var graphWithPreviews = AddPreviewObjects(graph, job.OutputPrefix, images.Count, adapter);
        await UploadImagesAsync(storage, job.OutputPrefix, images, cancellationToken);
        var graphObject = $"{job.OutputPrefix}/element-graph.json";
        var scanObject = $"{job.OutputPrefix}/scan.json";
        await storage.UploadJsonAsync(graphObject, graphWithPreviews, DocumentJsonContext.Default.ElementGraph, cancellationToken);
        await storage.UploadJsonAsync(scanObject, scan, DocumentJsonContext.Default.DocumentScan, cancellationToken);
        Console.WriteLine(JsonSerializer.Serialize(new { eventType = "preview_render", jobId = job.JobId,
            slideCount = graph.Slides.Count }));
        return new WorkerOutputs(graphObject, scanObject, validationObject, null, graph.Slides.Count, scan.DocumentSha256);
    }));
    return Results.Accepted(value: new { status = "accepted", jobId = job.JobId });
});

app.Run();

static void AcceptJob(ConcurrentDictionary<string, byte> activeJobs, string jobId, Func<Task> work)
{
    // ConcurrentDictionary.GetOrAdd may invoke its value factory more than once.
    // Claim membership first so an at-least-once delivery cannot process the
    // same document job twice at once.
    if (!activeJobs.TryAdd(jobId, 0)) return;
    _ = Task.Run(async () =>
    {
        try
        {
            await work();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                eventType = "document_job_delivery_failed",
                jobId,
                errorType = exception.GetType().Name,
                error = exception.Message
            }));
        }
        finally
        {
            activeJobs.TryRemove(jobId, out var _removedMarker);
        }
    });
}

static void Authorize(HttpRequest request)
{
    var expected = Environment.GetEnvironmentVariable("SPELLBOOK_INTERNAL_TOKEN");
    if (!string.IsNullOrWhiteSpace(expected) && request.Headers["x-spellbook-internal-token"] != expected)
        throw new BadHttpRequestException("Invalid internal token.", StatusCodes.Status401Unauthorized);
}

static async Task ExecuteJob(
    string jobId,
    string callbackUrl,
    IHttpClientFactory clients,
    LocalObjectStore storage,
    string outputPrefix,
    Func<CancellationToken, Task<WorkerOutputs>> work)
{
    var cancellationToken = CancellationToken.None;
    var receiptObject = $"{outputPrefix}/worker-result.json";
    var saved = await storage.TryReadJsonAsync<WorkerCallback>(receiptObject, cancellationToken);
    if (saved is not null)
    {
        if (saved.JobId != jobId || saved.Status is not ("succeeded" or "failed"))
            throw new InvalidDataException("Stored worker result has an invalid identity.");
        await CallbackAsync(clients, callbackUrl, saved, cancellationToken);
        return;
    }
    WorkerCallback callback;
    try
    {
        callback = new WorkerCallback(jobId, "succeeded", await work(cancellationToken), null);
    }
    catch (ChangeBudgetExceededException exception)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new
        {
            eventType = "document_job_failed",
            jobId,
            stage = "change_budget",
            errorType = exception.GetType().Name,
            error = exception.Message
        }));
        callback = new WorkerCallback(
            jobId,
            "failed",
            new WorkerOutputs("", null, exception.ValidationObject, null, 0, exception.DocumentSha256),
            exception.Message);
    }
    catch (Exception exception)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new
        {
            eventType = "document_job_failed",
            jobId,
            stage = "processing",
            errorType = exception.GetType().Name,
            error = exception.Message
        }));
        callback = new WorkerCallback(jobId, "failed", null, SafeError(exception), WorkerFailure.Code(exception));
    }
    await storage.UploadControlReceiptAsync(receiptObject, callback, cancellationToken);
    await CallbackAsync(clients, callbackUrl, callback, cancellationToken);
}

static string SafeError(Exception exception) => exception switch
{
    InvalidDataException => exception.Message,
    FileNotFoundException => exception.Message,
    _ => "Document processing failed. Check worker logs with the job id."
};

static async Task CallbackAsync(IHttpClientFactory clients, string url, WorkerCallback callback, CancellationToken cancellationToken)
{
    using var message = new HttpRequestMessage(HttpMethod.Post, url)
    {
        Content = JsonContent.Create(callback)
    };
    var token = Environment.GetEnvironmentVariable("SPELLBOOK_INTERNAL_TOKEN");
    if (!string.IsNullOrWhiteSpace(token))
        message.Headers.Add("x-spellbook-internal-token", token);
    using var response = await clients.CreateClient().SendAsync(message, cancellationToken);
    response.EnsureSuccessStatusCode();
}

static IDocumentFormatAdapter RequireAdapter(IEnumerable<IDocumentFormatAdapter> adapters, string formatId) =>
    adapters.SingleOrDefault(adapter => string.Equals(adapter.FormatId, formatId, StringComparison.Ordinal)) ??
    throw new InvalidDataException($"Document format '{formatId}' is not enabled by this worker.");

static ElementGraph AddPreviewObjects(ElementGraph graph, string prefix, int imageCount, IDocumentFormatAdapter adapter)
{
    if (imageCount != graph.Slides.Count || !graph.Slides.Select(slide => slide.SlideIndex).Order().SequenceEqual(Enumerable.Range(0, imageCount)))
        throw new InvalidDataException("Rendered slide images do not match the document slide identities.");
    return graph with
    {
        RendererName = adapter.RendererName,
        RendererVersion = adapter.RendererVersion,
        Slides = graph.Slides.Select(slide => slide with
        {
            PreviewObject = $"{prefix}/slides/slide-{slide.SlideIndex + 1}.png"
        }).ToList()
    };
}

static async Task UploadImagesAsync(LocalObjectStore storage, string prefix, IReadOnlyList<string> images, CancellationToken cancellationToken)
{
    for (var index = 0; index < images.Count; index++)
        await storage.UploadFileAsync($"{prefix}/slides/slide-{index + 1}.png", images[index], cancellationToken);
}

public sealed record ScanRenderJob(
    string JobId,
    string CallbackUrl,
    string StorageNamespace,
    string FormatId,
    string InputObject,
    string OutputPrefix,
    string? BaselineInputObject = null,
    string? ChangeOrigin = null,
    IReadOnlyList<string>? ChangeTaskIds = null,
    PackageChangeBudgetRequest? ChangeBudget = null,
    string? BaselineGraphObject = null);
public sealed record WorkerOutputs(string GraphObject, string? ScanObject, string? ValidationObject, string? DocumentObject, int SlideCount, string DocumentSha256);
public sealed record WorkerCallback(string JobId, string Status, WorkerOutputs? Outputs, string? Error, string? ErrorCode = null);

public sealed class ChangeBudgetExceededException(
    string validationObject,
    string documentSha256) : Exception("native_change_budget_exceeded")
{
    public string ValidationObject { get; } = validationObject;
    public string DocumentSha256 { get; } = documentSha256;
}

public sealed class JobWorkspace : IDisposable
{
    public JobWorkspace(string jobId)
    {
        var safeId = new string(jobId.Where(char.IsLetterOrDigit).Take(80).ToArray());
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"spellbook-{safeId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public void Dispose() => Directory.Delete(Path, true);
}
