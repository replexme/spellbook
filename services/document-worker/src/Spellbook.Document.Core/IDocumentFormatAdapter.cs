namespace Spellbook.Document.Core;

/// <summary>
/// Owns every format-specific operation needed by the common job pipeline.
/// A new document type is added by implementing this contract; the worker,
/// storage, versioning and callback layers must not learn that format's internals.
/// </summary>
public interface IDocumentFormatAdapter
{
    string FormatId { get; }
    string FileExtension { get; }
    DocumentScan Scan(string path);
    ElementGraph Inspect(string path, DocumentScan? scan = null);
    Task<IReadOnlyList<string>> RenderAsync(
        string inputPath,
        string outputDirectory,
        CancellationToken cancellationToken = default);
    string RendererName { get; }
    string RendererVersion { get; }
}

/// <summary>
/// PowerPoint decks: the safety scan and element graph are read here (Open XML), the previews
/// and the font check come from the engine program present-pptx.
/// </summary>
public sealed class PptxDocumentFormatAdapter(PptxSafetyScanner scanner, EngineProgram engine) : IDocumentFormatAdapter
{
    /// <summary>The engine program (SPELLBOOK_PPTX_ENGINE, default /app/present-pptx), or null.</summary>
    public static string? ConfiguredEngine() => EngineProgram.Configured("SPELLBOOK_PPTX_ENGINE", "/app/present-pptx");

    public string FormatId => "pptx";
    public string FileExtension => ".pptx";
    public string RendererName => "Present";
    public string RendererVersion => EngineProgram.Version;

    public DocumentScan Scan(string path) => scanner.Scan(path);

    /// <summary>The graph, with the fonts the engine draws this deck with.</summary>
    public ElementGraph Inspect(string path, DocumentScan? scan = null) =>
        new PresentationInspector(RendererFontEnvironment.FromEngineReport(engine.Fonts(path))).Inspect(path, scan);

    public Task<IReadOnlyList<string>> RenderAsync(
        string inputPath,
        string outputDirectory,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(engine.RenderAll(inputPath, outputDirectory));
    }
}
