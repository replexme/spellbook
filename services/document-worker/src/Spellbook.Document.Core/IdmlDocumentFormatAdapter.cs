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
/// InDesign (IDML) documents, read by the engine program present-idml (SPELLBOOK_IDML_ENGINE,
/// default /app/present-idml). It answers `scan`, `graph`, `render-all` and `validate` with this
/// contract's DocumentScan, ElementGraph, page-N.png files and PackageChangeBudgetReport.
/// Documents are edited in the browser document view. Without the program the format is off.
/// </summary>
public sealed class IdmlDocumentFormatAdapter(string enginePath) : IDocumentFormatAdapter, IPackageChangeValidator
{
    readonly EngineProgram engine = new(enginePath, "idml");

    /// <summary>The engine program, or null when IDML is not enabled.</summary>
    public static string? ConfiguredEngine() => EngineProgram.Configured("SPELLBOOK_IDML_ENGINE", "/app/present-idml");

    public string FormatId => "idml";
    public string FileExtension => ".idml";
    public string RendererName => "Present";
    public string RendererVersion => EngineProgram.Version;

    public DocumentScan Scan(string path) =>
        JsonSerializer.Deserialize(engine.Run("scan", path), DocumentJsonContext.Default.DocumentScan)
        ?? throw new InvalidDataException("idml_scan_empty");

    public ElementGraph Inspect(string path, DocumentScan? scan = null) =>
        JsonSerializer.Deserialize(engine.Run("graph", path), DocumentJsonContext.Default.ElementGraph)
        ?? throw new InvalidDataException("idml_graph_empty");

    public PackageChangeBudgetReport Validate(string baselinePath, string candidatePath) =>
        JsonSerializer.Deserialize(engine.Run("validate", baselinePath, candidatePath), DocumentJsonContext.Default.PackageChangeBudgetReport)
        ?? throw new InvalidDataException("idml_validation_empty");

    public Task<IReadOnlyList<string>> RenderAsync(string inputPath, string outputDirectory, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(engine.RenderAll(inputPath, outputDirectory));
    }
}
