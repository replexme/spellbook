namespace Spellbook.Document.Core;

/// <summary>Prepares immutable resources from the worker's owned source object.</summary>
public interface IOwnedPresentationResources
{
    Task PrepareOwnedResourcesAsync(string inputPath, string inputObject,
        string? baselinePath, CancellationToken cancellationToken);
}
