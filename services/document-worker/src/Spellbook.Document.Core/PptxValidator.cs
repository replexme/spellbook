using System.IO.Compression;
using System.Xml.Linq;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

namespace Spellbook.Document.Core;

public sealed class PptxValidator
{
    public ValidationReport Validate(string basePath, string candidatePath, IReadOnlySet<string> allowedChangedParts,
        IReadOnlyDictionary<string, IReadOnlySet<uint>>? allowedShapeIds = null,
        IReadOnlySet<string>? structuralSlides = null, IReadOnlySet<string>? backgroundSlides = null,
        IReadOnlySet<string>? nonSlideParts = null)
    {
        var errors = new List<string>();
        var warnings = new List<string>();
        var baseHashes = EntryHashes(basePath);
        var candidateHashes = EntryHashes(candidatePath);
        var changed = baseHashes.Keys.Union(candidateHashes.Keys, StringComparer.Ordinal)
            .Where(path => !baseHashes.TryGetValue(path, out var before) ||
                           !candidateHashes.TryGetValue(path, out var after) ||
                           !string.Equals(before, after, StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToList();

        foreach (var part in changed.Where(part => !allowedChangedParts.Contains(part)))
        {
            errors.Add($"Unexpected package part changed: {part}");
        }
        if (allowedShapeIds is not null)
        {
            using var before = ZipFile.OpenRead(basePath);
            using var after = ZipFile.OpenRead(candidatePath);
            foreach (var part in changed.Where(allowedChangedParts.Contains))
            {
                if (nonSlideParts?.Contains(part) == true) continue;
                if (!allowedShapeIds.TryGetValue(part, out var ids) ||
                    !PreservesNonTargets(before.GetEntry(part), after.GetEntry(part), ids,
                        structuralSlides?.Contains(part) == true, backgroundSlides?.Contains(part) == true))
                    errors.Add($"Non-target slide content changed: {part}");
            }
        }

        var baseValidation = ValidateOpenXml(basePath);
        var candidateValidation = ValidateOpenXml(candidatePath);
        foreach (var newError in candidateValidation.Errors.Except(baseValidation.Errors, StringComparer.Ordinal))
        {
            errors.Add($"Open XML validation: {newError}");
        }
        if (candidateValidation.Failure is not null)
        {
            errors.Add($"Open XML validation could not read the candidate package: {candidateValidation.Failure}");
        }
        if (baseValidation.Failure is not null)
        {
            errors.Add($"Open XML validation could not read the source package; absence of new errors cannot be proven: {baseValidation.Failure}");
        }
        if (baseValidation.ReaderAdjustments?.Count > 0 || candidateValidation.ReaderAdjustments?.Count > 0)
        {
            warnings.Add("The Open XML SDK read a validation-only ZIP view; source and saved package bytes are unchanged. Non-ASCII entry names use UTF-8 URI encoding in that view. Missing relationship targets are reported as validation errors and excluded only from the SDK view so the remaining schema checks can finish.");
        }
        if (baseValidation.Errors.Count > 0)
        {
            warnings.Add($"The source document already had {baseValidation.Errors.Count} Open XML validation issue(s); no new issue is allowed.");
        }

        var candidateScan = new PptxSafetyScanner().Scan(candidatePath);
        if (candidateScan.HasExternalRelationships)
        {
            warnings.Add("The candidate retains external relationships from the source document.");
        }

        return new ValidationReport(
            ContractVersions.Current,
            errors.Count == 0,
            Hashing.FileSha256(basePath),
            candidateScan.DocumentSha256,
            changed,
            errors,
            warnings);
    }

    private static bool PreservesNonTargets(ZipArchiveEntry? before, ZipArchiveEntry? after, IReadOnlySet<uint> ids,
        bool allowTopology, bool allowBackground)
    {
        if (before is null || after is null) return false;
        using var beforeStream = before.Open();
        using var afterStream = after.Open();
        var original = XDocument.Load(beforeStream);
        var candidate = XDocument.Load(afterStream);
        // Replace only authorized top-level shapes with identity markers. Comparing
        // the remainder also protects z-order, backgrounds and slide metadata.
        foreach (var document in new[] { original, candidate })
        {
            var tree = document.Root?.Elements().FirstOrDefault(e => e.Name.LocalName == "cSld")?
                .Elements().FirstOrDefault(e => e.Name.LocalName == "spTree");
            if (tree is null) return false;
            if (allowBackground) tree.Parent?.Elements().Where(e => e.Name.LocalName == "bg").Remove();
            foreach (var id in ids)
            {
                var shapes = tree.Elements().Where(shape => shape.Elements()
                    .SelectMany(nv => nv.Elements())
                    .Any(nv => nv.Name.LocalName == "cNvPr" && (string?)nv.Attribute("id") == id.ToString(System.Globalization.CultureInfo.InvariantCulture)))
                    .ToList();
                if (allowTopology)
                {
                    if (shapes.Count > 1) return false;
                    shapes.Remove();
                }
                else
                {
                    if (shapes.Count != 1) return false;
                    shapes[0].ReplaceWith(new XElement("authorized-shape", new XAttribute("id", id)));
                }
            }
        }
        return XNode.DeepEquals(original.Root, candidate.Root);
    }

    private static Dictionary<string, string> EntryHashes(string path)
    {
        using var archive = ZipFile.OpenRead(path);
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)))
        {
            using var stream = entry.Open();
            hashes[entry.FullName] = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(stream));
        }
        return hashes;
    }

    // System.IO.Packaging resolves part URIs in escaped form but ignores a
    // ZIP entry stored with a literal Unicode name. PowerPoint can author that
    // entry with an escaped content-type override and an unescaped rel target.
    // Adapt only the SDK input. Missing target relationships are recorded as
    // errors before excluding them from this view, allowing the SDK to check
    // the remaining package. Comparisons/hashes use the original file.
    private static Stream OpenValidationInput(string path, out IReadOnlyList<string> adjustments,
        out IReadOnlyList<string> packageIssues)
    {
        using var archive = ZipFile.OpenRead(path);
        static string SdkName(string name) => string.Concat(name.EnumerateRunes()
            .Select(rune => rune.IsAscii ? rune.ToString() : Uri.EscapeDataString(rune.ToString())));
        var mapped = archive.Entries.Select(entry => (Entry: entry, Name: SdkName(entry.FullName))).ToList();
        var changes = mapped.Where(pair => pair.Entry.FullName != pair.Name)
            .Select(pair => $"{pair.Entry.FullName} -> {pair.Name}").ToList();
        if (mapped.Select(pair => pair.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != mapped.Count)
            throw new InvalidDataException("Ambiguous package entry names after SDK URI encoding.");
        if (mapped.Count > PptxSafetyScanner.DefaultMaxEntries ||
            new FileInfo(path).Length > PptxSafetyScanner.DefaultMaxCompressedBytes ||
            mapped.Sum(pair => pair.Entry.Length) > PptxSafetyScanner.DefaultMaxUncompressedBytes)
            throw new InvalidDataException("Package exceeds the bounded SDK validation view.");
        var names = mapped.Select(pair => Uri.UnescapeDataString(pair.Entry.FullName)).ToHashSet(StringComparer.Ordinal);
        if (names.Count != mapped.Count)
            throw new InvalidDataException("Ambiguous package entry URI aliases.");
        var issues = new List<string>();
        var relationshipViews = new Dictionary<string, XDocument>(StringComparer.Ordinal);
        foreach (var entry in archive.Entries.Where(entry => entry.FullName.EndsWith(".rels", StringComparison.Ordinal)))
        {
            using var stream = entry.Open();
            var relationships = XDocument.Load(stream);
            foreach (var relation in relationships.Root?.Elements().ToList() ?? [])
            {
                if (relation.Name.LocalName != "Relationship" ||
                    string.Equals((string?)relation.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase)) continue;
                var target = (string?)relation.Attribute("Target") ?? "";
                if (PptxSafetyScanner.TryResolveRelationshipTarget(entry.FullName, target, out var part) && names.Contains(part)) continue;
                var issue = $"/{entry.FullName}:relationship[{(string?)relation.Attribute("Id")}]:missing or invalid internal target '{target}'.";
                issues.Add(issue);
                changes.Add(issue);
                relation.Remove();
                relationshipViews[entry.FullName] = relationships;
            }
        }
        adjustments = changes;
        packageIssues = issues;
        if (changes.Count == 0) return File.OpenRead(path);
        var view = new MemoryStream();
        try
        {
            using (var output = new ZipArchive(view, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var (entry, name) in mapped)
                {
                    using var source = entry.Open();
                    using var destination = output.CreateEntry(name, CompressionLevel.Fastest).Open();
                    if (relationshipViews.TryGetValue(entry.FullName, out var relationships))
                        relationships.Save(destination, SaveOptions.DisableFormatting);
                    else source.CopyTo(destination);
                }
            }
            view.Position = 0;
            return view;
        }
        catch { view.Dispose(); throw; }
    }

    public OpenXmlPackageValidation ValidateOpenXml(string path)
    {
        try
        {
            using var input = OpenValidationInput(path, out var adjustments, out var packageIssues);
            using var document = PresentationDocument.Open(input, false);
            var validator = new OpenXmlValidator();
            var issues = validator.Validate(document)
                    .Select(error => $"{error.Part?.Uri}:{error.Path?.XPath}:{error.Description}")
                    .Concat(packageIssues)
                    .ToHashSet(StringComparer.Ordinal);
            foreach (var part in document.PresentationPart?.SlideParts ?? [])
            {
                var index = 0;
                foreach (var data in part.Slide?.Descendants<DocumentFormat.OpenXml.Drawing.GraphicData>() ?? [])
                {
                    if (data.Elements<DocumentFormat.OpenXml.Drawing.Table>().Any() && data.Uri?.Value != DrawingMlGraphicTypes.Table)
                        issues.Add($"{part.Uri}:graphicData[{index}]:table payload requires the standard table graphic-data URI.");
                    index++;
                }
            }
            return new OpenXmlPackageValidation(
                issues.Count == 0,
                issues.Order(StringComparer.Ordinal).ToList(),
                null,
                adjustments);
        }
        catch (Exception exception) when (
            exception is InvalidDataException or
            InvalidOperationException or
            IOException or
            ArgumentException or
            DocumentFormat.OpenXml.Packaging.OpenXmlPackageException)
        {
            return new OpenXmlPackageValidation(false, [], exception.GetType().Name);
        }
    }
}

public sealed record OpenXmlPackageValidation(
    bool Valid,
    IReadOnlyList<string> Errors,
    string? Failure,
    IReadOnlyList<string>? ReaderAdjustments = null);
