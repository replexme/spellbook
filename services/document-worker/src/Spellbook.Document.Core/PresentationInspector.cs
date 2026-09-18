using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

public sealed class PresentationInspector
{
    private static readonly HashSet<string> KnownElementKinds =
    [
        "sp", "pic", "graphicFrame", "grpSp", "cxnSp"
    ];

    private readonly RendererFontEnvironment fontEnvironment;

    public PresentationInspector() : this(RendererFontEnvironment.Detect())
    {
    }

    public PresentationInspector(RendererFontEnvironment fontEnvironment)
    {
        this.fontEnvironment = fontEnvironment;
    }

    public ElementGraph Inspect(string path, DocumentScan? existingScan = null)
    {
        var scan = existingScan ?? new PptxSafetyScanner().Scan(path);
        using var archive = ZipFile.OpenRead(path);
        var presentationRoot = LoadXml(archive.GetEntry("ppt/presentation.xml") ??
            throw new InvalidDataException("The package has no presentation part."));
        var presentationRelationships = LoadXml(archive.GetEntry("ppt/_rels/presentation.xml.rels") ??
            throw new InvalidDataException("The package has no presentation relationships."));
        var slideSize = presentationRoot.Descendants()
            .FirstOrDefault(element => element.Name.LocalName == "sldSz") ??
            throw new InvalidDataException("The presentation has no slide size.");
        var slideWidth = ParseRequiredLong(slideSize, "cx", "Slide width is missing.");
        var slideHeight = ParseRequiredLong(slideSize, "cy", "Slide height is missing.");
        var slideIdList = presentationRoot.Descendants()
            .FirstOrDefault(element => element.Name.LocalName == "sldIdLst");
        var slideIds = (slideIdList?.Elements() ?? [])
            .Where(element => element.Name.LocalName == "sldId")
            .Select((element, index) => new
            {
                Index = index,
                RelationshipId = element.Attributes()
                    .FirstOrDefault(attribute =>
                        attribute.Name.LocalName == "id" &&
                        !string.IsNullOrEmpty(attribute.Name.NamespaceName))?
                    .Value
            })
            .ToList();
        var relationships = presentationRelationships.Descendants()
            .Where(element => element.Name.LocalName == "Relationship")
            .Select(element => new PackageRelationship(
                (string?)element.Attribute("Id"),
                (string?)element.Attribute("Type"),
                (string?)element.Attribute("Target"),
                (string?)element.Attribute("TargetMode")))
            .Where(relationship => !string.IsNullOrWhiteSpace(relationship.Id))
            .GroupBy(relationship => relationship.Id!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        var fontAudit = new PptxFontAuditor().Audit(path, fontEnvironment);
        var warnings = scan.Warnings.ToList();
        var hasFontRisk = !fontAudit.InventoryAvailable || fontAudit.MissingFonts.Count > 0;
        if (!fontAudit.InventoryAvailable)
        {
            warnings.Add("렌더러 글꼴 목록을 확인하지 못해 렌더링 충실도를 판정할 수 없습니다.");
        }
        else if (fontAudit.MissingFonts.Count > 0)
        {
            var shown = string.Join(", ", fontAudit.MissingFonts.Take(12));
            var remainder = fontAudit.MissingFonts.Count > 12 ? $" 외 {fontAudit.MissingFonts.Count - 12}개" : string.Empty;
            warnings.Add($"렌더러에 없는 글꼴: {shown}{remainder}");
        }
        if (fontAudit.Substitutions.Count > 0)
        {
            var shown = string.Join(", ", fontAudit.Substitutions.Take(8).Select(item => $"{item.Original}→{item.Substituted}"));
            var remainder = fontAudit.Substitutions.Count > 8 ? $" 외 {fontAudit.Substitutions.Count - 8}개" : string.Empty;
            warnings.Add($"렌더링 대체 글꼴: {shown}{remainder}");
        }
        var slides = new List<SlideGraph>();
        var riskyExternalParts = scan.RiskyExternalRelationshipSourceParts.ToHashSet(StringComparer.Ordinal);
        var hasUnscopedExternalContentRisk = riskyExternalParts.Any(part =>
            !part.StartsWith("ppt/slides/slide", StringComparison.Ordinal) ||
            !part.EndsWith(".xml", StringComparison.Ordinal));
        for (var index = 0; index < slideIds.Count; index++)
        {
            var relationshipId = slideIds[index].RelationshipId ??
                throw new InvalidDataException($"Slide {index + 1} has no relationship id.");
            if (!relationships.TryGetValue(relationshipId, out var relationship) ||
                string.IsNullOrWhiteSpace(relationship.Target) ||
                relationship.Type?.EndsWith("/slide", StringComparison.OrdinalIgnoreCase) != true ||
                string.Equals(relationship.TargetMode, "External", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"Slide {index + 1} has an invalid package relationship.");
            }
            var partPath = ResolvePartPath("ppt/presentation.xml", relationship.Target);
            var entry = archive.GetEntry(partPath) ??
                throw new InvalidDataException($"Slide part '{partPath}' is missing from ZIP package.");
            var slide = LoadXml(entry);
            var hasExternalContentRisk = hasUnscopedExternalContentRisk || riskyExternalParts.Contains(partPath);
            var inherited = new List<XDocument>();
            var layout = Related(archive, partPath, "/slideLayout");
            if (layout is not null)
            {
                inherited.Add(layout.Value.Xml);
                var master = Related(archive, layout.Value.Path, "/slideMaster");
                if (master is not null) inherited.Add(master.Value.Xml);
            }
            slides.Add(InspectSlide(index, $"/{partPath}", slide, hasExternalContentRisk, hasFontRisk, inherited, LinkedChartRelationships(archive, partPath)));
        }

        return new ElementGraph(
            ContractVersions.Current,
            scan.DocumentSha256,
            slideWidth,
            slideHeight,
            fontAudit.InventoryAvailable,
            fontAudit.DeclaredFonts,
            fontAudit.MissingFonts,
            fontAudit.Substitutions,
            slides,
            warnings.Distinct(StringComparer.Ordinal).ToList());
    }

    private static (string Path, XDocument Xml)? Related(ZipArchive archive, string source, string kind)
    {
        var relPath = source[..(source.LastIndexOf('/') + 1)] + "_rels/" + source[(source.LastIndexOf('/') + 1)..] + ".rels";
        if (archive.GetEntry(relPath) is not { } entry) return null;
        var relation = LoadXml(entry).Root!.Elements().FirstOrDefault(e => ((string?)e.Attribute("Type"))?.EndsWith(kind, StringComparison.Ordinal) == true && (string?)e.Attribute("TargetMode") != "External");
        if (relation is null) return null;
        var path = ResolvePartPath(source, (string)relation.Attribute("Target")!);
        return archive.GetEntry(path) is { } part ? (path, LoadXml(part)) : null;
    }

    internal static XElement? ShapeTransform(XElement shape) => shape.Elements().FirstOrDefault(e => e.Name.LocalName == "xfrm")
        ?? shape.Elements().Where(e => e.Name.LocalName is "spPr" or "grpSpPr").SelectMany(e => e.Elements()).FirstOrDefault(e => e.Name.LocalName == "xfrm");

    // Slide relationship ids of charts whose data is a linked, external workbook.
    private static IReadOnlySet<string> LinkedChartRelationships(ZipArchive archive, string slidePath)
    {
        var linked = new HashSet<string>(StringComparer.Ordinal);
        foreach (var relation in RelationshipsOf(archive, slidePath))
        {
            var type = (string?)relation.Attribute("Type");
            var target = (string?)relation.Attribute("Target");
            var id = (string?)relation.Attribute("Id");
            if (id is null || target is null || type?.EndsWith("/chart", StringComparison.Ordinal) != true ||
                string.Equals((string?)relation.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                continue;
            var chartPath = ResolvePartPath(slidePath, target);
            if (archive.GetEntry(chartPath) is not { } chartEntry) continue;
            var dataId = LoadXml(chartEntry).Descendants()
                .FirstOrDefault(element => element.Name.LocalName == "externalData")?
                .Attributes().FirstOrDefault(attribute => attribute.Name.LocalName == "id")?.Value;
            if (dataId is null) continue;
            var data = RelationshipsOf(archive, chartPath)
                .FirstOrDefault(element => (string?)element.Attribute("Id") == dataId);
            if (string.Equals((string?)data?.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                linked.Add(id);
        }
        return linked;
    }

    private static IEnumerable<XElement> RelationshipsOf(ZipArchive archive, string partPath)
    {
        var slash = partPath.LastIndexOf('/') + 1;
        var relPath = partPath[..slash] + "_rels/" + partPath[slash..] + ".rels";
        return archive.GetEntry(relPath) is { } entry
            ? LoadXml(entry).Root?.Elements() ?? []
            : [];
    }

    private static string? GraphicKindOf(XElement frame)
    {
        var uri = (string?)frame.Descendants().FirstOrDefault(element => element.Name.LocalName == "graphicData")?.Attribute("uri");
        return uri switch
        {
            DrawingMlGraphicTypes.Table => "table",
            DrawingMlGraphicTypes.Chart => "chart",
            DrawingMlGraphicTypes.Diagram => "diagram",
            DrawingMlGraphicTypes.Ole => "ole",
            _ => "other"
        };
    }

    private static SlideGraph InspectSlide(int slideIndex, string partUri, XDocument slide, bool hasExternalContentRisk, bool hasFontRisk, IReadOnlyList<XDocument> inherited, IReadOnlySet<string> linkedCharts)
    {
        var shapeTree = slide.Descendants().FirstOrDefault(element => element.Name.LocalName == "spTree") ??
            throw new InvalidDataException($"Slide {slideIndex + 1} has no shape tree.");
        var warnings = new List<string>();
        var elements = new List<ElementNode>();
        var zIndex = 0;
        var hasActiveXControls = slide.Descendants().Any(element => element.Name.LocalName == "controls");
        var hasUnsupported = hasExternalContentRisk || hasFontRisk || hasActiveXControls;

        foreach (var shape in shapeTree.Elements().Where(element => KnownElementKinds.Contains(element.Name.LocalName)))
        {
            var properties = shape.Descendants().FirstOrDefault(element => element.Name.LocalName == "cNvPr");
            var idRaw = (string?)properties?.Attribute("id");
            if (!uint.TryParse(idRaw, out var shapeId) || shapeId == 0)
            {
                warnings.Add($"슬라이드 {slideIndex + 1}에서 ID가 없는 요소를 건너뛰었습니다.");
                hasUnsupported = true;
                continue;
            }

            var transform = ShapeTransform(shape);
            var placeholder = shape.Descendants().FirstOrDefault(e => e.Name.LocalName == "ph");
            if (transform is null && placeholder is not null)
            {
                var index = (string?)placeholder.Attribute("idx") ?? "0";
                var type = (string?)placeholder.Attribute("type") ?? "obj";
                for (var level = 0; level < inherited.Count && transform is null; level++)
                {
                    var matches = inherited[level].Descendants().Where(e => e.Name.LocalName == "sp").Where(candidate =>
                    {
                        var ph = candidate.Descendants().FirstOrDefault(e => e.Name.LocalName == "ph");
                        if (ph is null) return false;
                        return level == 0 ? ((string?)ph.Attribute("idx") ?? "0") == index
                            : ((string?)ph.Attribute("type") ?? "obj") == (type == "ctrTitle" ? "title" : type);
                    }).ToArray();
                    if (matches.Length == 1)
                    {
                        transform = ShapeTransform(matches[0]);
                        type = (string?)matches[0].Descendants().First(e => e.Name.LocalName == "ph").Attribute("type") ?? type;
                    }
                }
            }
            var offset = transform?.Elements().FirstOrDefault(element => element.Name.LocalName == "off");
            var extent = transform?.Elements().FirstOrDefault(element => element.Name.LocalName == "ext");
            var kind = MapKind(shape.Name.LocalName);
            var isPlaceholder = shape.Descendants().Any(element => element.Name.LocalName == "ph");
            var textRuns = shape.Descendants().Where(element => element.Name.LocalName == "t").Select(element => element.Value).ToList();
            var hasX = TryLong(offset, "x", out var x);
            var hasY = TryLong(offset, "y", out var y);
            var hasWidth = TryLong(extent, "cx", out var width);
            var hasHeight = TryLong(extent, "cy", out var height);
            var hasTransform = hasX && hasY && hasWidth && hasHeight;
            // Text placeholders can be edited without flattening inherited geometry.
            // Non-text objects support envelope operations; operation-specific checks
            // in the patcher reject unsupported inner-content edits.
            var editable = kind == "shape" || hasTransform;
            string? unsupportedReason = null;
            if (!editable)
            {
                unsupportedReason = kind switch
                {
                    "picture" => "그림은 MVP에서 선택할 수 있지만 직접 수정하지 않습니다.",
                    "graphicFrame" => "표·차트·SmartArt 편집은 지원하지 않습니다.",
                    "group" => "그룹 내부 편집은 지원하지 않습니다.",
                    "connector" => "연결선 편집은 지원하지 않습니다.",
                    _ when isPlaceholder => "레이아웃 자리표시자 편집은 지원하지 않습니다.",
                    _ => "좌표를 안전하게 해석할 수 없습니다."
                };
            }

            if (kind is "graphicFrame" or "group" || (!hasTransform && kind != "connector"))
            {
                hasUnsupported = true;
            }

            var graphicKind = kind == "graphicFrame" ? GraphicKindOf(shape) : null;
            var chartRelationship = graphicKind == "chart"
                ? shape.Descendants().FirstOrDefault(element => element.Name.LocalName == "chart")?
                    .Attributes().FirstOrDefault(attribute => attribute.Name.LocalName == "id")?.Value
                : null;
            var rotationRaw = (string?)transform?.Attribute("rot");
            var rotation = long.TryParse(rotationRaw, out var rotationUnits) ? rotationUnits / 60000d : 0d;
            elements.Add(new ElementNode(
                $"{partUri}#{shapeId}",
                shapeId,
                kind,
                (string?)properties?.Attribute("name") ?? $"{kind} {shapeId}",
                textRuns.Count == 0 ? null : PptxTextContent.Read(shape),
                x,
                y,
                Math.Max(0, width),
                Math.Max(0, height),
                rotation,
                zIndex++,
                editable,
                unsupportedReason,
                Hashing.ElementSha256(shape),
                shape.Descendants().FirstOrDefault(e => e.Name.LocalName == "tbl")?.Elements()
                    .Where(e => e.Name.LocalName == "tr").Select(row => (IReadOnlyList<string>)row.Elements()
                        .Where(e => e.Name.LocalName == "tc").Select(PptxTextContent.Read).ToArray()).ToArray(),
                (string?)transform?.Attribute("flipH") is "1" or "true",
                (string?)transform?.Attribute("flipV") is "1" or "true",
                graphicKind,
                chartRelationship is not null && linkedCharts.Contains(chartRelationship)));
        }

        if (hasExternalContentRisk)
        {
            warnings.Add("외부 연결 콘텐츠가 포함되어 이 슬라이드의 렌더링 충실도는 B 등급입니다.");
        }
        if (hasActiveXControls)
        {
            warnings.Add("ActiveX 컨트롤은 웹에서 직접 편집할 수 없지만 다운로드 파일에는 보존됩니다.");
        }

        return new SlideGraph(
            slideIndex,
            partUri,
            null,
            hasUnsupported ? "B" : "A",
            elements,
            warnings);
    }

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

    private static long ParseRequiredLong(XElement element, string attributeName, string message) =>
        long.TryParse((string?)element.Attribute(attributeName), out var value)
            ? value
            : throw new InvalidDataException(message);

    private static string ResolvePartPath(string sourcePartPath, string target)
    {
        if (target.Contains('\\'))
        {
            throw new InvalidDataException($"Unsafe package relationship target: '{target}'.");
        }

        var packageRoot = new Uri("https://spellbook.invalid/");
        var source = new Uri(packageRoot, sourcePartPath);
        if (!Uri.TryCreate(source, target, out var resolved) ||
            !string.Equals(resolved.Scheme, packageRoot.Scheme, StringComparison.Ordinal) ||
            !string.Equals(resolved.Host, packageRoot.Host, StringComparison.Ordinal) ||
            !string.IsNullOrEmpty(resolved.Query) ||
            !string.IsNullOrEmpty(resolved.Fragment))
        {
            throw new InvalidDataException($"Unsafe package relationship target: '{target}'.");
        }

        var partPath = Uri.UnescapeDataString(resolved.AbsolutePath).TrimStart('/');
        if (string.IsNullOrWhiteSpace(partPath) ||
            partPath.Split('/').Any(segment => segment is "" or "." or ".."))
        {
            throw new InvalidDataException($"Unsafe package relationship target: '{target}'.");
        }
        return partPath;
    }

    private static bool TryLong(XElement? element, string attributeName, out long value) =>
        long.TryParse((string?)element?.Attribute(attributeName), out value);

    private static string MapKind(string localName) => localName switch
    {
        "sp" => "shape",
        "pic" => "picture",
        "graphicFrame" => "graphicFrame",
        "grpSp" => "group",
        "cxnSp" => "connector",
        _ => "unknown"
    };

    private sealed record PackageRelationship(
        string? Id,
        string? Type,
        string? Target,
        string? TargetMode);
}
