using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Spellbook.Document.Core;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<LocalObjectStore>();
builder.Services.AddSingleton<PptxSafetyScanner>();
builder.Services.AddSingleton(RendererFontEnvironment.Detect());
builder.Services.AddSingleton<PresentationInspector>();
builder.Services.AddSingleton<PptxPatcher>();
builder.Services.AddSingleton<IPresentationRenderer, LibreOfficeRenderer>();
builder.Services.AddSingleton<IDocumentFormatAdapter, PptxDocumentFormatAdapter>();
builder.Services.AddHttpClient();

var app = builder.Build();
var activeJobs = new ConcurrentDictionary<string, byte>();

app.MapGet("/health", (IPresentationRenderer renderer) => Results.Ok(new
{
    status = "ok",
    renderer = new { name = renderer.Name, version = renderer.Version }
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
        string? baselinePath = null;
        if (adapter.FormatId == "pptx" && !string.IsNullOrWhiteSpace(job.BaselineInputObject))
        {
            var incomingPath = Path.Combine(workspace.Path, $"incoming{adapter.FileExtension}");
            baselinePath = Path.Combine(workspace.Path, $"baseline{adapter.FileExtension}");
            await storage.DownloadAsync(job.InputObject, incomingPath, cancellationToken);
            await storage.DownloadAsync(job.BaselineInputObject, baselinePath, cancellationToken);
            var preservation = new PptxUnsupportedFeaturePreserver()
                .Preserve(baselinePath, incomingPath, inputPath);
            if (!string.Equals(
                preservation.CandidateDocumentSha256,
                preservation.OutputDocumentSha256,
                StringComparison.Ordinal))
                await storage.UploadFileAsync(job.InputObject, inputPath, cancellationToken);
        }
        else
        {
            await storage.DownloadAsync(job.InputObject, inputPath, cancellationToken);
        }
        WorkerFailure.RejectCompoundFile(inputPath);
        string? validationObject = null;
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
            var validation = new PptxPackageChangeBudgetValidator()
                .Validate(baselinePath, inputPath, job.ChangeBudget);
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
        var images = await adapter.RenderAsync(inputPath, Path.Combine(workspace.Path, "slides"), cancellationToken);
        var graphWithPreviews = AddPreviewObjects(graph, job.OutputPrefix, images.Count, adapter);
        var graphObject = $"{job.OutputPrefix}/element-graph.json";
        var scanObject = $"{job.OutputPrefix}/scan.json";
        await storage.UploadJsonAsync(graphObject, graphWithPreviews, DocumentJsonContext.Default.ElementGraph, cancellationToken);
        await storage.UploadJsonAsync(scanObject, scan, DocumentJsonContext.Default.DocumentScan, cancellationToken);
        await UploadImagesAsync(storage, job.OutputPrefix, images, cancellationToken);
        return new WorkerOutputs(graphObject, scanObject, validationObject, null, images.Count, scan.DocumentSha256);
    }));
    return Results.Accepted(value: new { status = "accepted", jobId = job.JobId });
});

app.MapPost("/internal/jobs/patch-render", (
    HttpRequest request,
    PatchRenderJob job,
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
        var outputPath = Path.Combine(workspace.Path, $"candidate{adapter.FileExtension}");
        await storage.DownloadAsync(job.InputObject, inputPath, cancellationToken);
        var assets = new Dictionary<string, byte[]>();
        foreach (var asset in job.AssetObjects ?? new Dictionary<string, string>())
        {
            if (assets.Count >= 12) throw new InvalidDataException("Too many image assets.");
            var data = await storage.ReadAsync(asset.Value, cancellationToken);
            if (data.Length > 5_000_000) throw new InvalidDataException("Image asset exceeds size limit.");
            assets.Add(asset.Key, data);
        }
        var patch = adapter.Patch(inputPath, outputPath, job.Command, assets);
        if (!patch.Validation.Valid)
            throw new InvalidDataException(string.Join(" ", patch.Validation.Errors));
        var images = await adapter.RenderAsync(outputPath, Path.Combine(workspace.Path, "slides"), cancellationToken);
        var graphWithPreviews = AddPreviewObjects(patch.CandidateGraph, job.OutputPrefix, images.Count, adapter);
        var graphObject = $"{job.OutputPrefix}/element-graph.json";
        var reportObject = $"{job.OutputPrefix}/validation.json";
        await storage.UploadFileAsync(job.OutputDocumentObject, outputPath, cancellationToken);
        await storage.UploadJsonAsync(graphObject, graphWithPreviews, DocumentJsonContext.Default.ElementGraph, cancellationToken);
        await storage.UploadJsonAsync(reportObject, patch.Validation, DocumentJsonContext.Default.ValidationReport, cancellationToken);
        await UploadImagesAsync(storage, job.OutputPrefix, images, cancellationToken);
        return new WorkerOutputs(graphObject, null, reportObject, job.OutputDocumentObject, images.Count, patch.Validation.CandidateDocumentSha256);
    }));
    return Results.Accepted(value: new { status = "accepted", jobId = job.JobId });
});

app.Run();

static void AcceptJob(ConcurrentDictionary<string, byte> activeJobs, string jobId, Func<Task> work)
{
    // ConcurrentDictionary.GetOrAdd may invoke its value factory more than once.
    // Claim membership first so an at-least-once delivery cannot start two
    // LibreOffice processes for the same document job.
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
    PackageChangeBudgetRequest? ChangeBudget = null);
public sealed record PatchRenderJob(string JobId, string CallbackUrl, string StorageNamespace, string FormatId, string InputObject, string OutputDocumentObject, string OutputPrefix, EditCommandBatch Command, Dictionary<string, string>? AssetObjects = null);
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
