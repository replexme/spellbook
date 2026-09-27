namespace Spellbook.Document.Core;

public interface IPresentationRenderer
{
    string Name { get; }

    string Version { get; }

    Task<IReadOnlyList<string>> RenderAsync(
        string pptxPath,
        string outputDirectory,
        CancellationToken cancellationToken,
        IReadOnlyList<int>? slideIndexes = null);
}
