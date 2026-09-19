using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

/// <summary>
/// Compares two saves produced by the same Office engine and rejects package
/// changes outside an operation family's declared OOXML budget.
/// </summary>
public sealed class PptxPackageChangeBudgetValidator
{
    private static readonly XNamespace DrawingNamespace =
        "http://schemas.openxmlformats.org/drawingml/2006/main";
    private static readonly XNamespace PresentationNamespace =
        "http://schemas.openxmlformats.org/presentationml/2006/main";
    private static readonly XNamespace CorePropertiesNamespace =
        "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
    private static readonly XNamespace DublinCoreTermsNamespace =
        "http://purl.org/dc/terms/";
    private static readonly XNamespace ExtendedPropertiesNamespace =
        "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
    private static readonly XNamespace CollaboraExtensionNamespace =
        "urn:com:collaboraoffice:names:experimental:ooxml:xmlns:coext:1.0";
    private static readonly XNamespace ChartNamespace =
        "http://schemas.openxmlformats.org/drawingml/2006/chart";
    private static readonly XNamespace PackageRelationshipNamespace =
        "http://schemas.openxmlformats.org/package/2006/relationships";
    private static readonly XNamespace OfficeRelationshipNamespace =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private const string OfficeDocumentRelationshipType =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

    public static IReadOnlySet<string> Categories { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        "package_manifest",
        "package_relationships",
        "document_properties",
        "presentation",
        "presentation_relationships",
        "slide_parts",
        "slide_relationships",
        "notes_parts",
        "notes_relationships",
        "notes_master_parts",
        "notes_master_relationships",
        "slide_layout_parts",
        "slide_layout_relationships",
        "slide_master_parts",
        "slide_master_relationships",
        "theme_parts",
        "chart_parts",
        "embedded_workbooks",
        "media_parts",
        "diagram_parts",
        "comments",
        "custom_xml",
        "macros",
        "unknown"
    };

    public PackageChangeBudgetReport Validate(
        string baselinePath,
        string candidatePath,
        PackageChangeBudgetRequest budget)
    {
        if (!string.Equals(budget.ContractVersion, ContractVersions.Current, StringComparison.Ordinal))
            throw new InvalidDataException($"Unsupported package change budget contract: {budget.ContractVersion}");

        var allowedCategories = budget.AllowedCategories.ToHashSet(StringComparer.Ordinal);
        var unknownCategories = allowedCategories.Except(Categories, StringComparer.Ordinal).Order().ToArray();
        if (unknownCategories.Length > 0)
            throw new InvalidDataException($"Unknown package change categories: {string.Join(", ", unknownCategories)}");

        var allowedExactParts = (budget.AllowedExactParts ?? [])
            .Select(NormalizePart)
            .ToHashSet(StringComparer.Ordinal);
        var targetIndexes = budget.TargetSlideIndexes?.Distinct().Order().ToArray() ?? [];
        if (targetIndexes.Any(index => index < 0))
            throw new InvalidDataException("Target slide indexes must be non-negative.");

        var baselineHashes = EntryHashes(baselinePath);
        var candidateHashes = EntryHashes(candidatePath);
        var baselineScope = targetIndexes.Length == 0 ? null : ResolveTargetScope(baselinePath, targetIndexes);
        var candidateScope = targetIndexes.Length == 0 ? null : ResolveTargetScope(candidatePath, targetIndexes);
        var targetScope = baselineScope is null
            ? null
            : baselineScope.Union(candidateScope ?? [], StringComparer.Ordinal).ToHashSet(StringComparer.Ordinal);
        var errors = new List<string>();
        var changes = new List<PackagePartChange>();

        foreach (var part in baselineHashes.Keys.Union(candidateHashes.Keys, StringComparer.Ordinal).Order())
        {
            var before = baselineHashes.GetValueOrDefault(part);
            var after = candidateHashes.GetValueOrDefault(part);
            if (string.Equals(before, after, StringComparison.Ordinal)) continue;

            var kind = before is null ? "added" : after is null ? "removed" : "modified";
            var category = Classify(part);
            var inTargetScope = targetScope is null || !IsTargetScoped(category) || targetScope.Contains(part);
            changes.Add(new PackagePartChange(part, category, kind, inTargetScope));

            if (!allowedExactParts.Contains(part) && !allowedCategories.Contains(category))
                errors.Add($"Package part exceeds the declared change budget: {part} ({category})");
            else if (!inTargetScope)
                errors.Add($"Package part is outside the targeted slide scope: {part}");
            if (kind != "modified" && !budget.AllowPartCreationOrDeletion)
                errors.Add($"Package part {kind} without creation/deletion authority: {part}");
        }

        return new PackageChangeBudgetReport(
            ContractVersions.Current,
            errors.Count == 0,
            Hashing.FileSha256(baselinePath),
            Hashing.FileSha256(candidatePath),
            changes,
            errors);
    }

    public static string Classify(string rawPart)
    {
        var part = NormalizePart(rawPart);
        if (part == "[Content_Types].xml") return "package_manifest";
        if (part == "_rels/.rels") return "package_relationships";
        if (part.StartsWith("docProps/", StringComparison.Ordinal)) return "document_properties";
        if (part == "ppt/presentation.xml" || part is "ppt/presProps.xml" or "ppt/viewProps.xml")
            return "presentation";
        if (part == "ppt/_rels/presentation.xml.rels") return "presentation_relationships";
        if (part.StartsWith("ppt/slides/_rels/", StringComparison.Ordinal)) return "slide_relationships";
        if (part.StartsWith("ppt/slides/", StringComparison.Ordinal)) return "slide_parts";
        if (part.StartsWith("ppt/notesSlides/_rels/", StringComparison.Ordinal)) return "notes_relationships";
        if (part.StartsWith("ppt/notesSlides/", StringComparison.Ordinal)) return "notes_parts";
        if (part.StartsWith("ppt/notesMasters/_rels/", StringComparison.Ordinal)) return "notes_master_relationships";
        if (part.StartsWith("ppt/notesMasters/", StringComparison.Ordinal)) return "notes_master_parts";
        if (part.StartsWith("ppt/slideLayouts/_rels/", StringComparison.Ordinal)) return "slide_layout_relationships";
        if (part.StartsWith("ppt/slideLayouts/", StringComparison.Ordinal)) return "slide_layout_parts";
        if (part.StartsWith("ppt/slideMasters/_rels/", StringComparison.Ordinal)) return "slide_master_relationships";
        if (part.StartsWith("ppt/slideMasters/", StringComparison.Ordinal)) return "slide_master_parts";
        if (part.StartsWith("ppt/theme/", StringComparison.Ordinal)) return "theme_parts";
        if (part.StartsWith("ppt/charts/", StringComparison.Ordinal)) return "chart_parts";
        if (part.StartsWith("ppt/embeddings/", StringComparison.Ordinal)) return "embedded_workbooks";
        if (part.StartsWith("ppt/media/", StringComparison.Ordinal)) return "media_parts";
        if (part.StartsWith("ppt/diagrams/", StringComparison.Ordinal)) return "diagram_parts";
        if (part.StartsWith("ppt/comments/", StringComparison.Ordinal)
            || part.StartsWith("ppt/commentAuthors", StringComparison.Ordinal)) return "comments";
        if (part.StartsWith("customXml/", StringComparison.Ordinal)) return "custom_xml";
        if (part == "ppt/vbaProject.bin" || part.StartsWith("ppt/vbaProjectSignature", StringComparison.Ordinal))
            return "macros";
        return "unknown";
    }

    private static bool IsTargetScoped(string category) => category is
        "slide_parts" or "slide_relationships" or
        "notes_parts" or "notes_relationships" or
        "chart_parts" or "embedded_workbooks" or "media_parts" or "diagram_parts";

    // Reads the slide order and each target slide's part closure straight
    // from the package relationships. System.IO.Packaging rejects valid
    // packages whose relationship targets use non-ASCII part names (for
    // example a transition sound named "Cortázar.wav"), so the Open XML SDK
    // is not used here.
    private static HashSet<string> ResolveTargetScope(string path, IReadOnlyList<int> targetIndexes)
    {
        using var archive = ZipFile.OpenRead(path);
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)))
            entries.TryAdd(NormalizePart(entry.FullName), entry);

        List<(string Id, string Type, string Target)> Relationships(string sourcePart)
        {
            var relationships = new List<(string Id, string Type, string Target)>();
            var relationshipPart = sourcePart.Length == 0 ? "_rels/.rels" : RelationshipPartFor(sourcePart);
            if (!entries.TryGetValue(relationshipPart, out var relationshipEntry)) return relationships;
            using var stream = relationshipEntry.Open();
            foreach (var relationship in XDocument.Load(stream).Root?
                .Elements(PackageRelationshipNamespace + "Relationship") ?? [])
            {
                if ((string?)relationship.Attribute("TargetMode") == "External") continue;
                relationships.Add((
                    (string?)relationship.Attribute("Id") ?? "",
                    (string?)relationship.Attribute("Type") ?? "",
                    ResolveTarget(sourcePart, (string?)relationship.Attribute("Target") ?? "")));
            }
            return relationships;
        }

        var presentationPart = Relationships("")
            .Where(relationship => relationship.Type == OfficeDocumentRelationshipType)
            .Select(relationship => relationship.Target)
            .FirstOrDefault();
        if (presentationPart is null || !entries.TryGetValue(presentationPart, out var presentationEntry))
            throw new InvalidDataException("The PPTX has no presentation part.");
        var presentationTargets = Relationships(presentationPart)
            .GroupBy(relationship => relationship.Id, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().Target, StringComparer.Ordinal);
        XDocument presentation;
        using (var stream = presentationEntry.Open())
            presentation = XDocument.Load(stream);
        var orderedSlides = presentation.Root?
            .Element(PresentationNamespace + "sldIdLst")?
            .Elements(PresentationNamespace + "sldId")
            .Select(slideId => (string?)slideId.Attribute(OfficeRelationshipNamespace + "id") is { } id
                && presentationTargets.TryGetValue(id, out var target)
                && entries.ContainsKey(target)
                    ? target
                    : throw new InvalidDataException("A slide relationship does not resolve to a slide part."))
            .ToArray() ?? [];
        if (targetIndexes.Any(index => index >= orderedSlides.Length))
            throw new InvalidDataException("A target slide index is outside the saved presentation.");

        var scope = new HashSet<string>(StringComparer.Ordinal);
        void AddPartClosure(string part)
        {
            var actual = entries.TryGetValue(part, out var entry) ? NormalizePart(entry.FullName) : part;
            if (!scope.Add(actual)) return;
            scope.Add(RelationshipPartFor(actual));
            foreach (var relationship in Relationships(actual))
                AddPartClosure(relationship.Target);
        }
        foreach (var index in targetIndexes)
            AddPartClosure(orderedSlides[index]);
        return scope;
    }

    private static string ResolveTarget(string sourcePart, string target)
    {
        var resolved = new Uri(new Uri($"http://package.invalid/{sourcePart}"), target);
        return NormalizePart(Uri.UnescapeDataString(resolved.AbsolutePath));
    }

    private static string RelationshipPartFor(string part)
    {
        var slash = part.LastIndexOf('/');
        return slash < 0
            ? $"_rels/{part}.rels"
            : $"{part[..slash]}/_rels/{part[(slash + 1)..]}.rels";
    }

    private static Dictionary<string, string> EntryHashes(string path)
    {
        using var archive = ZipFile.OpenRead(path);
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)))
        {
            var part = NormalizePart(entry.FullName);
            if (!hashes.TryAdd(part, HashEntry(entry, part)))
                throw new InvalidDataException($"Duplicate package part: {part}");
        }
        return hashes;
    }

    private static string HashEntry(ZipArchiveEntry entry, string part)
    {
        using var stream = entry.Open();
        if (!part.EndsWith(".xml", StringComparison.Ordinal))
            return Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(stream));

        var document = XDocument.Load(stream, LoadOptions.PreserveWhitespace);
        // Office regenerates DrawingML field GUIDs on save. Their document
        // order, type and contents are persisted semantics; the GUID itself is
        // not. Ordinal normalization still detects added, removed, reordered
        // or otherwise modified fields.
        var fieldIndex = 0;
        foreach (var field in document.Descendants(DrawingNamespace + "fld"))
            field.SetAttributeValue("id", $"{{00000000-0000-0000-0000-{++fieldIndex:D12}}}");

        // Collabora also regenerates its private page GUID on every independent
        // save. The value is not referenced elsewhere in the package; retain
        // the element, order and every other attribute while removing only the
        // non-deterministic UUID from change-budget comparison.
        var pageGuidIndex = 0;
        foreach (var pageGuid in document.Descendants(CollaboraExtensionNamespace + "pageGuid"))
            pageGuid.SetAttributeValue("val", $"{{00000000-0000-0000-0000-{++pageGuidIndex:D12}}}");

        // LibreOffice can deterministically renumber non-visual object ids in
        // slide-layout parts while preserving the complete layout tree. Scope
        // this normalization to layouts: slide ids can be animation targets
        // and therefore remain exact. All other object attributes, ordering,
        // placeholder data and cross-references continue to affect the hash.
        if (part.StartsWith("ppt/slideLayouts/", StringComparison.Ordinal))
        {
            var objectIndex = 0;
            foreach (var nonVisualProperties in document.Descendants(PresentationNamespace + "cNvPr"))
                nonVisualProperties.SetAttributeValue("id", (++objectIndex).ToString());
        }

        // Date, footer and slide-number placeholders in master/layout parts
        // carry a cached display value. Independent Office sessions can
        // replace the authoring prompt (for example, "<number>") with the
        // evaluated value (for example, "1") after a slide-layout change.
        // The placeholder kind, field type, run structure and formatting are
        // the persisted semantics; the cache text is not. Normalize only the
        // text nodes owned by these three placeholder kinds and only in
        // master/layout parts so ordinary authored slide text remains exact.
        if (part.StartsWith("ppt/slideLayouts/", StringComparison.Ordinal)
            || part.StartsWith("ppt/slideMasters/", StringComparison.Ordinal))
        {
            foreach (var shape in document.Descendants(PresentationNamespace + "sp"))
            {
                var placeholderType = (string?)shape
                    .Descendants(PresentationNamespace + "ph")
                    .FirstOrDefault()
                    ?.Attribute("type");
                if (placeholderType is not ("dt" or "ftr" or "sldNum")) continue;

                var textIndex = 0;
                foreach (var text in shape
                    .Descendants(PresentationNamespace + "txBody")
                    .Descendants(DrawingNamespace + "t"))
                    text.Value = $"__office_placeholder_cache_{++textIndex}__";
            }
        }

        // LibreOffice picks random chart axis ids when it exports a chart it
        // has loaded, so two saves of an unchanged chart can differ only in
        // those numbers. The ids only link chart types to their axes and axes
        // to each other inside this part; renumbering them by first
        // appearance keeps every link, so an added, removed or re-linked axis
        // still changes the hash.
        if (part.StartsWith("ppt/charts/", StringComparison.Ordinal))
        {
            var axisIds = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var reference in document.Descendants()
                .Where(element => element.Name == ChartNamespace + "axId"
                    || element.Name == ChartNamespace + "crossAx"))
            {
                var value = (string?)reference.Attribute("val");
                if (value is null) continue;
                if (!axisIds.TryGetValue(value, out var ordinal))
                    axisIds[value] = ordinal = (axisIds.Count + 1).ToString();
                reference.SetAttributeValue("val", ordinal);
            }
        }

        if (part == "docProps/core.xml")
        {
            foreach (var property in document.Root?.Elements() ?? [])
            {
                if (property.Name == CorePropertiesNamespace + "lastModifiedBy"
                    || property.Name == CorePropertiesNamespace + "revision"
                    || property.Name == DublinCoreTermsNamespace + "modified")
                    property.Value = "__office_save_metadata__";
            }
        }

        // Office updates the accumulated editing duration according to how
        // long an independent session stayed open. It is save telemetry, not
        // authored presentation content, and therefore cannot make a longer
        // mutation scenario exceed its OOXML change budget. Keep every other
        // extended property exact so company, application and document-stat
        // changes remain visible.
        if (part == "docProps/app.xml")
        {
            foreach (var totalTime in document.Descendants(ExtendedPropertiesNamespace + "TotalTime"))
                totalTime.Value = "__office_save_duration__";
        }

        var canonical = Encoding.UTF8.GetBytes(document.ToString(SaveOptions.DisableFormatting));
        return Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(canonical));
    }

    private static string NormalizePart(string part) => part.Replace('\\', '/').TrimStart('/');
}
