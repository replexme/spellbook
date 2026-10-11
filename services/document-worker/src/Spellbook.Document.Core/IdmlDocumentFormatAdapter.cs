using System.Diagnostics;
using System.Text.Json;

namespace Spellbook.Document.Core;

/// <summary>
/// A format whose saves the format itself checks against the version they were edited from.
/// </summary>
public interface IPackageChangeValidator
{
    PackageChangeBudgetReport Validate(string baselinePath, string candidatePath);
}

/// <summary>
/// InDesign (IDML) documents, read by an external IDML engine program named by
/// SPELLBOOK_IDML_ENGINE. The program answers `scan`, `graph`, `render-all` and `validate`
/// with this contract's DocumentScan, ElementGraph, page-N.png files and
/// PackageChangeBudgetReport. Documents are edited in the browser document view, so this
/// adapter never patches. Without the setting the format is not enabled.
/// </summary>
public sealed class IdmlDocumentFormatAdapter(string enginePath) : IDocumentFormatAdapter, IPackageChangeValidator
{
    static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    /// <summary>The configured engine program, or null when IDML is not enabled.</summary>
    public static string? ConfiguredEngine() =>
        Environment.GetEnvironmentVariable("SPELLBOOK_IDML_ENGINE") is { Length: > 0 } path && File.Exists(path) ? path : null;

    public string FormatId => "idml";
    public string FileExtension => ".idml";
    public string RendererName => "Present IDML";
    public string RendererVersion => "external";

    public DocumentScan Scan(string path) =>
        JsonSerializer.Deserialize(Run("scan", path), DocumentJsonContext.Default.DocumentScan)
        ?? throw new InvalidDataException("idml_scan_empty");

    public ElementGraph Inspect(string path, DocumentScan? scan = null) =>
        JsonSerializer.Deserialize(Run("graph", path), DocumentJsonContext.Default.ElementGraph)
        ?? throw new InvalidDataException("idml_graph_empty");

    public PackageChangeBudgetReport Validate(string baselinePath, string candidatePath) =>
        JsonSerializer.Deserialize(Run("validate", baselinePath, candidatePath), DocumentJsonContext.Default.PackageChangeBudgetReport)
        ?? throw new InvalidDataException("idml_validation_empty");

    public PatchResult Patch(string inputPath, string outputPath, EditCommandBatch command, IReadOnlyDictionary<string, byte[]>? assets = null) =>
        throw new NotSupportedException("idml_documents_are_edited_in_the_document_view");

    public Task<IReadOnlyList<string>> RenderAsync(string inputPath, string outputDirectory, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<string> pages = Run("render-all", inputPath, outputDirectory, "1280")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return Task.FromResult(pages);
    }

    string Run(params string[] arguments)
    {
        var start = new ProcessStartInfo(enginePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("idml_engine_unavailable");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(Timeout))
        {
            process.Kill(entireProcessTree: true);
            throw new RenderTimeoutException(Timeout);
        }
        if (process.ExitCode != 0)
        {
            // The engine names the problem on its first line; document contents never reach the log.
            var reason = stderr.Result.Split('\n', 2)[0].Trim();
            throw new InvalidDataException($"idml_{arguments[0]}_failed: {reason[..Math.Min(reason.Length, 300)]}");
        }
        return stdout.Result;
    }
}
