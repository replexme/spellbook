using System.Text.Json;
using System.Text.Json.Serialization;

namespace Spellbook.Document.Core;

public static class ContractVersions
{
    public const string Current = "1.0";
}

public sealed record DocumentScan(
    string ContractVersion,
    string DocumentSha256,
    long CompressedBytes,
    long UncompressedBytes,
    int EntryCount,
    int SlideCount,
    bool HasExternalRelationships,
    IReadOnlyList<string> RiskyExternalRelationshipSourceParts,
    IReadOnlyList<string> Warnings);

public sealed record ElementGraph(
    string ContractVersion,
    string DocumentSha256,
    long SlideWidthEmu,
    long SlideHeightEmu,
    bool FontInventoryAvailable,
    IReadOnlyList<string> DeclaredFonts,
    IReadOnlyList<string> MissingFonts,
    IReadOnlyList<FontSubstitution> FontSubstitutions,
    IReadOnlyList<SlideGraph> Slides,
    IReadOnlyList<string> Warnings,
    string? RendererName = null,
    string? RendererVersion = null);

public sealed record SlideGraph(
    int SlideIndex,
    string PartUri,
    string? PreviewObject,
    string SupportGrade,
    IReadOnlyList<ElementNode> Elements,
    IReadOnlyList<string> Warnings);

public sealed record ElementNode(
    string ElementId,
    uint ShapeId,
    string Kind,
    string Name,
    string? Text,
    long X,
    long Y,
    long Width,
    long Height,
    double Rotation,
    int ZIndex,
    bool Editable,
    string? UnsupportedReason,
    string SourceHash,
    IReadOnlyList<IReadOnlyList<string>>? TableCells = null,
    bool FlipHorizontal = false,
    bool FlipVertical = false,
    // For graphic frames: table, chart, diagram (SmartArt), ole or other.
    string? GraphicKind = null,
    // A chart whose data lives in a linked (external) workbook.
    bool ExternalData = false);

public sealed record PackageChangeBudgetRequest(
    string ContractVersion,
    IReadOnlyList<string> AllowedCategories,
    IReadOnlyList<int>? TargetSlideIndexes = null,
    IReadOnlyList<string>? AllowedExactParts = null,
    bool AllowPartCreationOrDeletion = false);

public sealed record PackagePartChange(
    string Part,
    string Category,
    string ChangeKind,
    bool InTargetScope);

public sealed record PackageChangeBudgetReport(
    string ContractVersion,
    bool Valid,
    string BaselineDocumentSha256,
    string CandidateDocumentSha256,
    IReadOnlyList<PackagePartChange> Changes,
    IReadOnlyList<string> Errors);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DocumentScan))]
[JsonSerializable(typeof(ElementGraph))]
[JsonSerializable(typeof(PackageChangeBudgetRequest))]
[JsonSerializable(typeof(PackageChangeBudgetReport))]
public partial class DocumentJsonContext : JsonSerializerContext;
