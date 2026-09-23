using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

/// <summary>
/// Restores package features that LibreOffice does not import into its editable
/// model and would otherwise delete during a save. Only an explicitly supported
/// untouched feature family is copied; collisions fail closed instead of
/// replacing candidate content.
/// </summary>
public sealed class PptxUnsupportedFeaturePreserver
{
    private static readonly IReadOnlySet<string> PreservedPresentationRelationshipTypes =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps"
        };
    private static readonly XNamespace PresentationNamespace =
        "http://schemas.openxmlformats.org/presentationml/2006/main";
    private static readonly XNamespace DrawingNamespace =
        "http://schemas.openxmlformats.org/drawingml/2006/main";
    private static readonly XNamespace OfficeRelationshipNamespace =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static readonly XNamespace PackageRelationshipNamespace =
        "http://schemas.openxmlformats.org/package/2006/relationships";
    private static readonly XNamespace ContentTypesNamespace =
        "http://schemas.openxmlformats.org/package/2006/content-types";

    public UnsupportedFeaturePreservationReport Preserve(
        string baselinePath,
        string candidatePath,
        string outputPath)
    {
        if (!File.Exists(baselinePath))
            throw new FileNotFoundException("Baseline PPTX does not exist.", baselinePath);
        if (!File.Exists(candidatePath))
            throw new FileNotFoundException("Candidate PPTX does not exist.", candidatePath);

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        File.Copy(candidatePath, outputPath, overwrite: true);

        var restoredSlides = new List<int>();
        var copiedParts = new HashSet<string>(StringComparer.Ordinal);
        using (var baseline = ZipFile.OpenRead(baselinePath))
        using (var output = ZipFile.Open(outputPath, ZipArchiveMode.Update))
        {
            var baselineSlides = OrderedSlideParts(baseline);
            var candidateSlides = OrderedSlideParts(output);
            foreach (var (baselineSlidePath, slideIndex) in baselineSlides.Select((part, index) => (part, index)))
            {
                var baselineSlide = ReadXml(baseline, baselineSlidePath);
                var sourceControls = baselineSlide.Root?
                    .Element(PresentationNamespace + "cSld")?
                    .Element(PresentationNamespace + "controls");
                if (sourceControls is null) continue;
                if (slideIndex >= candidateSlides.Count)
                    throw new InvalidDataException($"Candidate PPTX has no slide {slideIndex + 1} for preserved controls.");

                var candidateSlidePath = candidateSlides[slideIndex];
                var candidateSlide = ReadXml(output, candidateSlidePath);
                var candidateCommonSlide = candidateSlide.Root?
                    .Element(PresentationNamespace + "cSld")
                    ?? throw new InvalidDataException($"Candidate slide {slideIndex + 1} has no common slide data.");
                var candidateControls = candidateCommonSlide.Element(PresentationNamespace + "controls");
                if (candidateControls is not null)
                {
                    if (!XNode.DeepEquals(sourceControls, candidateControls))
                        throw new InvalidDataException($"Candidate slide {slideIndex + 1} contains modified controls that cannot be merged safely.");
                    continue;
                }

                var controls = new XElement(sourceControls);
                var referencedIds = controls
                    .DescendantsAndSelf()
                    .Attributes()
                    .Where(attribute => attribute.Name.Namespace == OfficeRelationshipNamespace)
                    .Select(attribute => attribute.Value)
                    .ToHashSet(StringComparer.Ordinal);
                var baselineRelationships = ReadRelationships(baseline, baselineSlidePath);
                var candidateRelationships = ReadRelationships(output, candidateSlidePath, createIfMissing: true);
                var candidateIds = candidateRelationships.Document.Root!
                    .Elements(PackageRelationshipNamespace + "Relationship")
                    .Select(element => (string?)element.Attribute("Id"))
                    .Where(id => !string.IsNullOrWhiteSpace(id))
                    .Select(id => id!)
                    .ToHashSet(StringComparer.Ordinal);
                var relationshipIdMap = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var relationship in baselineRelationships.Document.Root!
                    .Elements(PackageRelationshipNamespace + "Relationship")
                    .Where(element =>
                    {
                        var type = (string?)element.Attribute("Type");
                        var id = (string?)element.Attribute("Id");
                        return type?.EndsWith("/control", StringComparison.OrdinalIgnoreCase) == true
                            || type?.EndsWith("/vmlDrawing", StringComparison.OrdinalIgnoreCase) == true
                            || (!string.IsNullOrWhiteSpace(id) && referencedIds.Contains(id));
                    }))
                {
                    var sourceId = (string?)relationship.Attribute("Id")
                        ?? throw new InvalidDataException("A preserved relationship has no id.");
                    var target = (string?)relationship.Attribute("Target")
                        ?? throw new InvalidDataException($"Preserved relationship {sourceId} has no target.");
                    if (string.Equals((string?)relationship.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Externally linked controls cannot be preserved safely.");
                    var targetPart = ResolvePartPath(baselineSlidePath, target);
                    CopyPartClosure(baseline, output, targetPart, copiedParts);

                    var candidateId = candidateIds.Add(sourceId)
                        ? sourceId
                        : NextRelationshipId(candidateIds);
                    relationshipIdMap[sourceId] = candidateId;
                    var copiedRelationship = new XElement(relationship);
                    copiedRelationship.SetAttributeValue("Id", candidateId);
                    candidateRelationships.Document.Root!.Add(copiedRelationship);
                }
                foreach (var attribute in controls
                    .DescendantsAndSelf()
                    .Attributes()
                    .Where(attribute => attribute.Name.Namespace == OfficeRelationshipNamespace))
                {
                    if (!relationshipIdMap.TryGetValue(attribute.Value, out var mapped))
                        throw new InvalidDataException($"Control relationship {attribute.Value} is missing from the source slide.");
                    attribute.Value = mapped;
                }

                var commonSlideExtensions = candidateCommonSlide.Element(PresentationNamespace + "extLst");
                if (commonSlideExtensions is null) candidateCommonSlide.Add(controls);
                else commonSlideExtensions.AddBeforeSelf(controls);
                WriteXml(output, candidateSlidePath, candidateSlide);
                WriteXml(output, candidateRelationships.Path, candidateRelationships.Document);
                restoredSlides.Add(slideIndex);
            }
            PreserveSlideContentAndBorders(baseline, output, baselineSlides, candidateSlides);
            PreservePresentationPackageFeatures(baseline, output, copiedParts);
            EnsureContentTypes(baseline, output, copiedParts);
        }

        return new UnsupportedFeaturePreservationReport(
            ContractVersions.Current,
            Hashing.FileSha256(baselinePath),
            Hashing.FileSha256(candidatePath),
            Hashing.FileSha256(outputPath),
            restoredSlides,
            copiedParts.Order(StringComparer.Ordinal).ToList());
    }

    private static void PreservePresentationPackageFeatures(
        ZipArchive baseline,
        ZipArchive output,
        ISet<string> copiedParts)
    {
        const string presentationPart = "ppt/presentation.xml";
        var sourceRelationships = ReadRelationships(baseline, presentationPart);
        var candidateRelationships = ReadRelationships(output, presentationPart);
        var candidateIds = candidateRelationships.Document.Root!
            .Elements(PackageRelationshipNamespace + "Relationship")
            .Select(element => (string?)element.Attribute("Id"))
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .ToHashSet(StringComparer.Ordinal);
        var changed = false;

        foreach (var sourceRelationship in sourceRelationships.Document.Root!
            .Elements(PackageRelationshipNamespace + "Relationship")
            .Where(element => PreservedPresentationRelationshipTypes.Contains(
                (string?)element.Attribute("Type") ?? string.Empty)))
        {
            var sourceId = (string?)sourceRelationship.Attribute("Id")
                ?? throw new InvalidDataException("A preserved presentation relationship has no id.");
            var type = (string?)sourceRelationship.Attribute("Type")
                ?? throw new InvalidDataException($"Preserved relationship {sourceId} has no type.");
            var sourceTarget = (string?)sourceRelationship.Attribute("Target")
                ?? throw new InvalidDataException($"Preserved relationship {sourceId} has no target.");
            if (string.Equals(
                (string?)sourceRelationship.Attribute("TargetMode"),
                "External",
                StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Preserved relationship {sourceId} cannot target external content.");

            var sourcePart = ResolvePartPath(presentationPart, sourceTarget);
            var matching = candidateRelationships.Document.Root!
                .Elements(PackageRelationshipNamespace + "Relationship")
                .Where(element => string.Equals(
                    (string?)element.Attribute("Type"),
                    type,
                    StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (matching.Length > 1)
                throw new InvalidDataException($"Candidate PPTX contains duplicate preserved relationships of type {type}.");
            if (matching.Length == 1)
            {
                var candidateTarget = (string?)matching[0].Attribute("Target")
                    ?? throw new InvalidDataException($"Candidate preserved relationship {type} has no target.");
                if (string.Equals(
                        (string?)matching[0].Attribute("TargetMode"),
                        "External",
                        StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(
                        ResolvePartPath(presentationPart, candidateTarget),
                        sourcePart,
                        StringComparison.Ordinal))
                    throw new InvalidDataException($"Candidate PPTX changed preserved relationship {type}.");
                CopyPartClosure(baseline, output, sourcePart, copiedParts);
                continue;
            }

            CopyPartClosure(baseline, output, sourcePart, copiedParts);
            var candidateId = candidateIds.Add(sourceId)
                ? sourceId
                : NextRelationshipId(candidateIds);
            var restoredRelationship = new XElement(sourceRelationship);
            restoredRelationship.SetAttributeValue("Id", candidateId);
            candidateRelationships.Document.Root!.Add(restoredRelationship);
            changed = true;
        }

        if (changed)
            WriteXml(output, candidateRelationships.Path, candidateRelationships.Document);
    }

    private static void PreserveSlideContentAndBorders(
        ZipArchive baseline,
        ZipArchive output,
        IReadOnlyList<string> baselineSlides,
        IReadOnlyList<string> candidateSlides)
    {
        if (baselineSlides.Count != candidateSlides.Count) return;
        for (var i = 0; i < baselineSlides.Count; i++)
        {
            var baseSlidePath = baselineSlides[i];
            var candSlidePath = candidateSlides[i];
            var baseSlide = ReadXml(baseline, baseSlidePath);
            var candSlide = ReadXml(output, candSlidePath);

            if (IsSlideSemanticallyUntouched(baseSlide, candSlide))
            {
                WriteXml(output, candSlidePath, baseSlide);
            }
            else
            {
                ReconcileTableBorders(baseSlide, candSlide);
                WriteXml(output, candSlidePath, candSlide);
            }
        }
    }

    private static bool IsSlideSemanticallyUntouched(XDocument baseline, XDocument candidate)
    {
        var baseText = string.Concat(baseline.Descendants(DrawingNamespace + "t").Select(e => e.Value));
        var candText = string.Concat(candidate.Descendants(DrawingNamespace + "t").Select(e => e.Value));
        if (string.IsNullOrWhiteSpace(baseText) && string.IsNullOrWhiteSpace(candText))
        {
            var baseNames = baseline.Descendants().Attributes("name").Select(a => a.Value).Order().ToList();
            var candNames = candidate.Descendants().Attributes("name").Select(a => a.Value).Order().ToList();
            return baseNames.SequenceEqual(candNames);
        }
        return string.Equals(baseText, candText, StringComparison.Ordinal);
    }

    private static void ReconcileTableBorders(XDocument baselineSlide, XDocument candidateSlide)
    {
        var baselineTables = baselineSlide.Descendants(DrawingNamespace + "tbl").ToList();
        var candidateTables = candidateSlide.Descendants(DrawingNamespace + "tbl").ToList();
        for (var t = 0; t < Math.Min(baselineTables.Count, candidateTables.Count); t++)
        {
            var baseRows = baselineTables[t].Elements(DrawingNamespace + "tr").ToList();
            var candRows = candidateTables[t].Elements(DrawingNamespace + "tr").ToList();
            if (baseRows.Count != candRows.Count) continue;
            for (var r = 0; r < baseRows.Count; r++)
            {
                var baseCells = baseRows[r].Elements(DrawingNamespace + "tc").ToList();
                var candCells = candRows[r].Elements(DrawingNamespace + "tc").ToList();
                if (baseCells.Count != candCells.Count) continue;
                for (var c = 0; c < baseCells.Count; c++)
                {
                    var baseTcPr = baseCells[c].Element(DrawingNamespace + "tcPr");
                    var candTcPr = candCells[c].Element(DrawingNamespace + "tcPr");
                    if (baseTcPr == null || candTcPr == null) continue;

                    var candLines = candTcPr.Elements()
                        .Where(e => e.Name.Namespace == DrawingNamespace && LineTagNames.Contains(e.Name.LocalName))
                        .ToList();
                    var hasBfbfbf = candLines.Any(l => l.ToString().Contains("BFBFBF", StringComparison.OrdinalIgnoreCase));
                    if (!hasBfbfbf) continue;

                    var baseLines = baseTcPr.Elements()
                        .Where(e => e.Name.Namespace == DrawingNamespace && LineTagNames.Contains(e.Name.LocalName))
                        .Select(e => new XElement(e))
                        .ToList();
                    if (baseLines.Count == 0) continue;

                    foreach (var line in candLines)
                        line.Remove();

                    var firstNonLine = candTcPr.Elements().FirstOrDefault();
                    if (firstNonLine != null)
                    {
                        foreach (var line in baseLines)
                            firstNonLine.AddBeforeSelf(line);
                    }
                    else
                    {
                        foreach (var line in baseLines)
                            candTcPr.Add(line);
                    }
                }
            }
        }
    }

    private static readonly HashSet<string> LineTagNames = new(StringComparer.Ordinal)
    {
        "lnL", "lnR", "lnT", "lnB", "lnTlToBr", "lnBlToTr"
    };

    private static IReadOnlyList<string> OrderedSlideParts(ZipArchive archive)
    {
        var presentation = ReadXml(archive, "ppt/presentation.xml");
        var relationships = ReadRelationships(archive, "ppt/presentation.xml").Document.Root!
            .Elements(PackageRelationshipNamespace + "Relationship")
            .Where(element => ((string?)element.Attribute("Type"))?.EndsWith("/slide", StringComparison.OrdinalIgnoreCase) == true)
            .ToDictionary(
                element => (string)element.Attribute("Id")!,
                element => ResolvePartPath("ppt/presentation.xml", (string)element.Attribute("Target")!),
                StringComparer.Ordinal);
        return presentation.Descendants(PresentationNamespace + "sldId")
            .Select(element => (string?)element.Attribute(OfficeRelationshipNamespace + "id"))
            .Select(id => !string.IsNullOrWhiteSpace(id) && relationships.TryGetValue(id, out var part)
                ? part
                : throw new InvalidDataException("A presentation slide relationship is missing."))
            .ToList();
    }

    private static void CopyPartClosure(
        ZipArchive baseline,
        ZipArchive output,
        string partPath,
        ISet<string> copiedParts)
    {
        if (!copiedParts.Add(partPath)) return;
        var sourceEntry = baseline.GetEntry(partPath)
            ?? throw new InvalidDataException($"Preserved package part is missing: {partPath}");
        CopyEntryFailClosed(sourceEntry, output, partPath);

        var relationshipPath = RelationshipPartFor(partPath);
        var relationshipEntry = baseline.GetEntry(relationshipPath);
        if (relationshipEntry is null) return;
        CopyEntryFailClosed(relationshipEntry, output, relationshipPath);
        var relationships = LoadXml(relationshipEntry);
        foreach (var relationship in relationships.Root!.Elements(PackageRelationshipNamespace + "Relationship"))
        {
            if (string.Equals((string?)relationship.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                continue;
            var target = (string?)relationship.Attribute("Target")
                ?? throw new InvalidDataException($"Relationship in {relationshipPath} has no target.");
            CopyPartClosure(baseline, output, ResolvePartPath(partPath, target), copiedParts);
        }
    }

    private static void CopyEntryFailClosed(ZipArchiveEntry source, ZipArchive output, string path)
    {
        var sourceBytes = ReadBytes(source);
        var existing = output.GetEntry(path);
        if (existing is not null)
        {
            if (!sourceBytes.AsSpan().SequenceEqual(ReadBytes(existing)))
                throw new InvalidDataException($"Preserved package part collides with candidate content: {path}");
            return;
        }
        using var destination = output.CreateEntry(path, CompressionLevel.Optimal).Open();
        destination.Write(sourceBytes);
    }

    private static void EnsureContentTypes(
        ZipArchive baseline,
        ZipArchive output,
        IReadOnlySet<string> copiedParts)
    {
        if (copiedParts.Count == 0) return;
        var source = ReadXml(baseline, "[Content_Types].xml");
        var candidate = ReadXml(output, "[Content_Types].xml");
        var sourceDefaults = source.Root!.Elements(ContentTypesNamespace + "Default")
            .Where(element => !string.IsNullOrWhiteSpace((string?)element.Attribute("Extension")))
            .ToDictionary(element => (string)element.Attribute("Extension")!, StringComparer.OrdinalIgnoreCase);
        var sourceOverrides = source.Root!.Elements(ContentTypesNamespace + "Override")
            .Where(element => !string.IsNullOrWhiteSpace((string?)element.Attribute("PartName")))
            .ToDictionary(element => ((string)element.Attribute("PartName")!).TrimStart('/'), StringComparer.Ordinal);
        var candidateDefaults = candidate.Root!.Elements(ContentTypesNamespace + "Default")
            .Where(element => !string.IsNullOrWhiteSpace((string?)element.Attribute("Extension")))
            .ToDictionary(element => (string)element.Attribute("Extension")!, StringComparer.OrdinalIgnoreCase);
        var candidateOverrides = candidate.Root!.Elements(ContentTypesNamespace + "Override")
            .Where(element => !string.IsNullOrWhiteSpace((string?)element.Attribute("PartName")))
            .ToDictionary(element => ((string)element.Attribute("PartName")!).TrimStart('/'), StringComparer.Ordinal);

        foreach (var part in copiedParts.Order(StringComparer.Ordinal))
        {
            if (sourceOverrides.TryGetValue(part, out var sourceOverride))
            {
                if (candidateOverrides.TryGetValue(part, out var candidateOverride))
                {
                    if (!string.Equals(
                        (string?)candidateOverride.Attribute("ContentType"),
                        (string?)sourceOverride.Attribute("ContentType"),
                        StringComparison.Ordinal))
                        throw new InvalidDataException($"Preserved package part has a conflicting content type: {part}");
                }
                else
                {
                    candidate.Root.Add(new XElement(sourceOverride));
                    candidateOverrides[part] = sourceOverride;
                }
                continue;
            }
            var extension = Path.GetExtension(part).TrimStart('.');
            if (!sourceDefaults.TryGetValue(extension, out var sourceDefault))
                throw new InvalidDataException($"Preserved package part has no content type: {part}");
            var sourceContentType = (string?)sourceDefault.Attribute("ContentType");
            if (!candidateDefaults.TryGetValue(extension, out var candidateDefault))
            {
                candidate.Root.Add(new XElement(sourceDefault));
                candidateDefaults[extension] = sourceDefault;
            }
            else if (!string.Equals((string?)candidateDefault.Attribute("ContentType"), sourceContentType, StringComparison.Ordinal))
            {
                var added = new XElement(ContentTypesNamespace + "Override",
                    new XAttribute("PartName", $"/{part}"),
                    new XAttribute("ContentType", sourceContentType
                        ?? throw new InvalidDataException($"Preserved package part has an empty content type: {part}")));
                candidate.Root.Add(added);
                candidateOverrides[part] = added;
            }
        }
        WriteXml(output, "[Content_Types].xml", candidate);
    }

    private static (string Path, XDocument Document) ReadRelationships(
        ZipArchive archive,
        string partPath,
        bool createIfMissing = false)
    {
        var relationshipPath = RelationshipPartFor(partPath);
        var entry = archive.GetEntry(relationshipPath);
        if (entry is not null) return (relationshipPath, LoadXml(entry));
        if (!createIfMissing)
            throw new InvalidDataException($"Package relationships are missing: {relationshipPath}");
        return (relationshipPath, new XDocument(
            new XDeclaration("1.0", "UTF-8", "yes"),
            new XElement(PackageRelationshipNamespace + "Relationships")));
    }

    private static string NextRelationshipId(ISet<string> existing)
    {
        for (var index = 1; index < int.MaxValue; index++)
        {
            var candidate = $"rId{index}";
            if (existing.Add(candidate)) return candidate;
        }
        throw new InvalidDataException("No relationship id is available for preserved package content.");
    }

    private static string RelationshipPartFor(string partPath)
    {
        var slash = partPath.LastIndexOf('/');
        return slash < 0
            ? $"_rels/{partPath}.rels"
            : $"{partPath[..slash]}/_rels/{partPath[(slash + 1)..]}.rels";
    }

    private static string ResolvePartPath(string sourcePartPath, string target)
    {
        if (target.Contains('\\'))
            throw new InvalidDataException($"Unsafe relationship target: {target}");
        var packageRoot = new Uri("https://spellbook.invalid/");
        var source = new Uri(packageRoot, sourcePartPath);
        if (!Uri.TryCreate(source, target, out var resolved)
            || resolved.Host != packageRoot.Host
            || resolved.Scheme != packageRoot.Scheme
            || !string.IsNullOrEmpty(resolved.Query)
            || !string.IsNullOrEmpty(resolved.Fragment))
            throw new InvalidDataException($"Unsafe relationship target: {target}");
        var path = Uri.UnescapeDataString(resolved.AbsolutePath).TrimStart('/');
        if (string.IsNullOrWhiteSpace(path) || path.Split('/').Any(segment => segment is "" or "." or ".."))
            throw new InvalidDataException($"Unsafe relationship target: {target}");
        return path;
    }

    private static XDocument ReadXml(ZipArchive archive, string path) =>
        LoadXml(archive.GetEntry(path)
            ?? throw new InvalidDataException($"Package part is missing: {path}"));

    private static XDocument LoadXml(ZipArchiveEntry entry)
    {
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 20_000_000
        });
        return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
    }

    private static byte[] ReadBytes(ZipArchiveEntry entry)
    {
        using var stream = entry.Open();
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private static void WriteXml(ZipArchive archive, string path, XDocument document)
    {
        archive.GetEntry(path)?.Delete();
        using var stream = archive.CreateEntry(path, CompressionLevel.Optimal).Open();
        document.Save(stream, SaveOptions.DisableFormatting);
    }
}
