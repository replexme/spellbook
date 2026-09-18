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

public sealed record EditTarget(int SlideIndex, string ElementId, string SourceHash);

public sealed record EditCommandBatch(
    string ContractVersion,
    string BaseDocumentSha256,
    string Summary,
    IReadOnlyList<JsonElement> Commands);

public sealed record PatchResult(
    ElementGraph CandidateGraph,
    ValidationReport Validation);

public sealed record ValidationReport(
    string ContractVersion,
    bool Valid,
    string BaseDocumentSha256,
    string CandidateDocumentSha256,
    IReadOnlyList<string> ChangedParts,
    IReadOnlyList<string> Errors,
    IReadOnlyList<string> Warnings);

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

public sealed record UnsupportedFeaturePreservationReport(
    string ContractVersion,
    string BaselineDocumentSha256,
    string CandidateDocumentSha256,
    string OutputDocumentSha256,
    IReadOnlyList<int> RestoredSlideIndexes,
    IReadOnlyList<string> CopiedParts);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DocumentScan))]
[JsonSerializable(typeof(ElementGraph))]
[JsonSerializable(typeof(EditCommandBatch))]
[JsonSerializable(typeof(PatchResult))]
[JsonSerializable(typeof(ValidationReport))]
[JsonSerializable(typeof(PackageChangeBudgetRequest))]
[JsonSerializable(typeof(PackageChangeBudgetReport))]
[JsonSerializable(typeof(UnsupportedFeaturePreservationReport))]
public partial class DocumentJsonContext : JsonSerializerContext;
