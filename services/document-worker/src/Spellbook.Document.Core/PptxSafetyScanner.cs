using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

public sealed class PptxSafetyScanner
{
    public const long DefaultMaxCompressedBytes = 50L * 1024 * 1024;
    public const long DefaultMaxUncompressedBytes = 250L * 1024 * 1024;
    public const int DefaultMaxEntries = 10_000;
    public const double DefaultMaxCompressionRatio = 100;
    public const int DefaultMaxSlides = 200;

    public DocumentScan Scan(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists)
        {
            throw new FileNotFoundException("PPTX file does not exist.", path);
        }

        if (!file.Extension.Equals(".pptx", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Only .pptx packages are accepted.");
        }

        if (file.Length <= 0 || file.Length > DefaultMaxCompressedBytes)
        {
            throw new InvalidDataException($"Compressed PPTX size must be between 1 and {DefaultMaxCompressedBytes} bytes.");
        }

        using var archive = ZipFile.OpenRead(path);
        if (archive.Entries.Count > DefaultMaxEntries)
        {
            throw new InvalidDataException($"PPTX contains more than {DefaultMaxEntries} entries.");
        }

        long totalUncompressed = 0;
        var hasContentTypes = false;
        var hasPresentation = false;
        var slideCount = 0;
        var hasExternalRelationships = false;
        var hasActiveXControls = false;
        var brokenInternalRelationships = 0;
        var riskyExternalRelationshipSourceParts = new HashSet<string>(StringComparer.Ordinal);
        var warnings = new List<string>();
        var entryNames = archive.Entries
            .Select(entry => entry.FullName)
            .ToHashSet(StringComparer.Ordinal);
        if (entryNames.Count != archive.Entries.Count)
            throw new InvalidDataException("PPTX contains duplicate ZIP entry names.");

        foreach (var entry in archive.Entries)
        {
            ValidateEntryPath(entry.FullName);
            checked
            {
                totalUncompressed += entry.Length;
            }

            if (totalUncompressed > DefaultMaxUncompressedBytes)
            {
                throw new InvalidDataException($"Expanded PPTX exceeds {DefaultMaxUncompressedBytes} bytes.");
            }

            if (entry.CompressedLength > 0 && entry.Length / (double)entry.CompressedLength > DefaultMaxCompressionRatio)
            {
                throw new InvalidDataException($"Entry '{entry.FullName}' exceeds the allowed compression ratio.");
            }

            hasContentTypes |= entry.FullName.Equals("[Content_Types].xml", StringComparison.Ordinal);
            hasPresentation |= entry.FullName.Equals("ppt/presentation.xml", StringComparison.Ordinal);
            hasActiveXControls |= entry.FullName.StartsWith("ppt/activeX/", StringComparison.Ordinal)
                || entry.FullName.StartsWith("ppt/drawings/", StringComparison.Ordinal)
                    && entry.FullName.EndsWith(".vml", StringComparison.OrdinalIgnoreCase);
            if (entry.FullName.StartsWith("ppt/slides/", StringComparison.Ordinal) &&
                entry.FullName.EndsWith(".xml", StringComparison.Ordinal) &&
                !entry.FullName.Contains("/_rels/", StringComparison.Ordinal))
            {
                slideCount++;
                if (slideCount > DefaultMaxSlides)
                    throw new InvalidDataException($"PPTX exceeds the beta limit of {DefaultMaxSlides} slides.");
            }

            if (entry.FullName.EndsWith(".rels", StringComparison.OrdinalIgnoreCase))
            {
                var relationshipScan = ScanRelationships(entry, entryNames);
                hasExternalRelationships |= relationshipScan.HasExternalRelationships;
                brokenInternalRelationships += relationshipScan.BrokenInternalRelationships;
                if (relationshipScan.HasRiskyExternalRelationships)
                {
                    riskyExternalRelationshipSourceParts.Add(RelationshipSourcePart(entry.FullName));
                }
            }
        }

        if (!hasContentTypes || !hasPresentation)
        {
            throw new InvalidDataException("The package is missing required PowerPoint parts.");
        }

        if (riskyExternalRelationshipSourceParts.Count > 0)
        {
            warnings.Add("외부 연결 콘텐츠가 있어 해당 슬라이드의 렌더링 충실도를 보증하지 않습니다.");
        }
        else if (hasExternalRelationships)
        {
            warnings.Add("외부 하이퍼링크가 포함되어 있으며 링크를 열 때만 외부 사이트로 이동합니다.");
        }
        if (brokenInternalRelationships > 0)
        {
            warnings.Add($"대상이 없거나 이름이 정확히 일치하지 않는 내부 관계 {brokenInternalRelationships}개를 발견했습니다. 정적 슬라이드 검사는 계속하지만 해당 부가 콘텐츠는 보증하지 않습니다.");
        }
        if (hasActiveXControls)
        {
            warnings.Add("ActiveX 컨트롤은 웹에서 직접 편집할 수 없지만 저장할 때 원본 패키지 요소를 그대로 보존합니다.");
        }

        return new DocumentScan(
            ContractVersions.Current,
            Hashing.FileSha256(path),
            file.Length,
            totalUncompressed,
            archive.Entries.Count,
            slideCount,
            hasExternalRelationships,
            riskyExternalRelationshipSourceParts.Order(StringComparer.Ordinal).ToList(),
            warnings);
    }

    private static void ValidateEntryPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.StartsWith('/') || path.StartsWith('\\'))
        {
            throw new InvalidDataException($"Unsafe ZIP entry path: '{path}'.");
        }

        var normalized = path.Replace('\\', '/');
        if (normalized.Split('/').Any(segment => segment is ".." or "."))
        {
            throw new InvalidDataException($"Unsafe ZIP entry path: '{path}'.");
        }
    }

    private static RelationshipScan ScanRelationships(
        ZipArchiveEntry entry,
        IReadOnlySet<string> entryNames)
    {
        using var stream = entry.Open();
        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 5_000_000
        });
        var document = XDocument.Load(reader, LoadOptions.None);
        var externalRelationships = document.Descendants()
            .Where(element =>
                element.Name.LocalName == "Relationship" &&
                string.Equals((string?)element.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var brokenInternalRelationships = document.Descendants()
            .Where(element =>
                element.Name.LocalName == "Relationship" &&
                !string.Equals((string?)element.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
            .Count(element =>
            {
                var target = (string?)element.Attribute("Target");
                return string.IsNullOrWhiteSpace(target) ||
                    !TryResolveRelationshipTarget(entry.FullName, target, out var partPath) ||
                    !entryNames.Contains(partPath);
            });
        return new RelationshipScan(
            externalRelationships.Count > 0,
            externalRelationships.Any(element => !IsPassiveHyperlink(element)),
            brokenInternalRelationships);
    }

    private static bool IsPassiveHyperlink(XElement relationship) =>
        ((string?)relationship.Attribute("Type"))?.EndsWith(
            "/hyperlink",
            StringComparison.OrdinalIgnoreCase) == true;

    private static string RelationshipSourcePart(string relationshipPath)
    {
        var normalized = relationshipPath.Replace('\\', '/');
        const string marker = "/_rels/";
        var markerIndex = normalized.LastIndexOf(marker, StringComparison.Ordinal);
        if (markerIndex >= 0 && normalized.EndsWith(".rels", StringComparison.OrdinalIgnoreCase))
        {
            var directory = normalized[..(markerIndex + 1)];
            var fileName = normalized[(markerIndex + marker.Length)..^5];
            return directory + fileName;
        }

        return string.Empty;
    }

    internal static bool TryResolveRelationshipTarget(
        string relationshipPath,
        string target,
        out string partPath)
    {
        partPath = string.Empty;
        if (target.Contains('\\'))
        {
            return false;
        }

        var packageRoot = new Uri("https://spellbook.invalid/");
        var source = new Uri(packageRoot, RelationshipSourcePart(relationshipPath));
        if (!Uri.TryCreate(source, target, out var resolved) ||
            !string.Equals(resolved.Scheme, packageRoot.Scheme, StringComparison.Ordinal) ||
            !string.Equals(resolved.Host, packageRoot.Host, StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(resolved.Query) ||
            !string.IsNullOrEmpty(resolved.Fragment))
        {
            return false;
        }

        partPath = Uri.UnescapeDataString(resolved.AbsolutePath).TrimStart('/');
        return !string.IsNullOrWhiteSpace(partPath) &&
            !partPath.Split('/').Any(segment => segment is "" or "." or "..");
    }

    private sealed record RelationshipScan(
        bool HasExternalRelationships,
        bool HasRiskyExternalRelationships,
        int BrokenInternalRelationships);
}
