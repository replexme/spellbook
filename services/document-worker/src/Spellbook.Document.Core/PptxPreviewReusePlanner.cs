using System.IO.Compression;
using System.Security.Cryptography;
using System.Xml;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

// Reuse prior previews only when every package part that can affect a slide
// is byte-identical. Document properties do not participate in slide render.
public static class PptxPreviewReusePlanner
{
    public static IReadOnlyList<int>? ChangedSlideIndexes(
        string baselinePath,
        string candidatePath,
        ElementGraph baseline,
        ElementGraph candidate,
        PackageChangeBudgetReport validation,
        IPresentationRenderer renderer)
    {
        if (!validation.Valid ||
            baseline.DocumentSha256 != validation.BaselineDocumentSha256 ||
            candidate.DocumentSha256 != validation.CandidateDocumentSha256 ||
            baseline.RendererName != renderer.Name ||
            baseline.RendererVersion != renderer.Version ||
            baseline.SlideWidthEmu != candidate.SlideWidthEmu ||
            baseline.SlideHeightEmu != candidate.SlideHeightEmu ||
            baseline.Slides.Count != candidate.Slides.Count ||
            baseline.Slides.Count == 0)
            return null;

        var slideParts = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < baseline.Slides.Count; index++)
        {
            var before = baseline.Slides[index];
            var after = candidate.Slides[index];
            if (before.SlideIndex != index || after.SlideIndex != index ||
                before.PartUri != after.PartUri ||
                string.IsNullOrWhiteSpace(before.PreviewObject))
                return null;
            var part = before.PartUri.TrimStart('/');
            if (!part.StartsWith("ppt/slides/slide", StringComparison.Ordinal) ||
                !part.EndsWith(".xml", StringComparison.Ordinal) ||
                !slideParts.TryAdd(part, index))
                return null;
        }

        using var oldZip = ZipFile.OpenRead(baselinePath);
        using var newZip = ZipFile.OpenRead(candidatePath);
        var oldEntries = Entries(oldZip);
        var newEntries = Entries(newZip);
        if (oldEntries is null || newEntries is null ||
            !oldEntries.Keys.Order().SequenceEqual(newEntries.Keys.Order()))
            return null;

        var changed = new SortedSet<int>();
        foreach (var part in oldEntries.Keys)
        {
            using var before = oldEntries[part].Open();
            using var after = newEntries[part].Open();
            if (SHA256.HashData(before).SequenceEqual(SHA256.HashData(after)))
                continue;
            if (part.StartsWith("docProps/", StringComparison.Ordinal))
                continue;
            if (part == "[Content_Types].xml" &&
                EquivalentContentTypes(oldEntries[part], newEntries[part]))
                continue;
            if (!slideParts.TryGetValue(part, out var slideIndex))
                return null;
            changed.Add(slideIndex);
        }
        return changed.ToArray();
    }

    private static bool EquivalentContentTypes(ZipArchiveEntry baseline, ZipArchiveEntry candidate)
    {
        try
        {
            return ContentTypes(baseline) is { } before &&
                ContentTypes(candidate) is { } after &&
                before.SequenceEqual(after);
        }
        catch (XmlException)
        {
            return false;
        }
    }

    private static IReadOnlyList<(string Kind, string Key, string Type)>? ContentTypes(ZipArchiveEntry entry)
    {
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null
        });
        var root = XDocument.Load(reader).Root;
        XNamespace ns = "http://schemas.openxmlformats.org/package/2006/content-types";
        if (root?.Name != ns + "Types" || root.Attributes().Any(attribute => !attribute.IsNamespaceDeclaration))
            return null;
        var result = new List<(string Kind, string Key, string Type)>();
        var seen = new HashSet<(string Kind, string Key)>();
        foreach (var item in root.Elements())
        {
            var isDefault = item.Name == ns + "Default";
            if (!isDefault && item.Name != ns + "Override") return null;
            var keyName = isDefault ? "Extension" : "PartName";
            var key = (string?)item.Attribute(keyName);
            var type = (string?)item.Attribute("ContentType");
            if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(type) ||
                item.HasElements || !string.IsNullOrWhiteSpace(item.Value) ||
                item.Attributes().Any(attribute =>
                    !attribute.IsNamespaceDeclaration &&
                    (attribute.Name.Namespace != XNamespace.None ||
                     attribute.Name.LocalName != keyName &&
                     attribute.Name.LocalName != "ContentType")))
                return null;
            var kind = isDefault ? "Default" : "Override";
            if (!seen.Add((kind, key))) return null;
            result.Add((kind, key, type));
        }
        return result.OrderBy(item => item.Kind, StringComparer.Ordinal)
            .ThenBy(item => item.Key, StringComparer.Ordinal).ToArray();
    }

    private static Dictionary<string, ZipArchiveEntry>? Entries(ZipArchive zip)
    {
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
        foreach (var entry in zip.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name)))
            if (!entries.TryAdd(entry.FullName.TrimStart('/'), entry))
                return null;
        return entries;
    }
}
