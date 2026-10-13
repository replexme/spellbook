using System.IO.Compression;
using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class DocumentEngineTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), $"spellbook-tests-{Guid.NewGuid():N}");

    public DocumentEngineTests() => Directory.CreateDirectory(directory);

    [Fact]
    public void ScannerRejectsDuplicateZipPartNames()
    {
        var path = TestPresentationFactory.Create(directory);
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Update))
        {
            using var output = archive.CreateEntry("ppt/presentation.xml").Open();
            output.Write("<duplicate/>"u8);
        }
        Assert.Throws<InvalidDataException>(() => new PptxSafetyScanner().Scan(path));
    }

    [Fact]
    public void ScanAndInspectFindEditableTextShape()
    {
        var path = TestPresentationFactory.Create(directory);
        var scan = new PptxSafetyScanner().Scan(path);
        var graph = new PresentationInspector().Inspect(path, scan);

        Assert.Equal(1, scan.SlideCount);
        Assert.Equal(12192000L, graph.SlideWidthEmu);
        var element = Assert.Single(Assert.Single(graph.Slides).Elements);
        Assert.Equal("shape", element.Kind);
        Assert.Equal("원본 제목", element.Text);
        Assert.True(element.Editable);
    }

    [Fact]
    public void InspectorIgnoresMissingUnrelatedPackagePart()
    {
        var path = TestPresentationFactory.Create(directory);
        AddInternalRelationship(
            path,
            "_rels/.rels",
            "rIdMissingThumbnail",
            "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
            "docProps/missing-thumbnail.jpeg");

        var graph = new PresentationInspector().Inspect(path);

        Assert.Single(graph.Slides);
        Assert.Equal("원본 제목", Assert.Single(graph.Slides[0].Elements).Text);
        Assert.Contains(graph.Warnings, warning => warning.Contains("내부 관계 1개", StringComparison.Ordinal));
    }

    [Fact]
    public void InspectorDoesNotTreatSectionMetadataAsAdditionalSlides()
    {
        var path = TestPresentationFactory.Create(directory);
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Update))
        {
            XNamespace sections = "http://schemas.microsoft.com/office/powerpoint/2010/main";
            var presentation = ReadXml(archive, "ppt/presentation.xml");
            presentation.Root?.Add(new XElement(
                sections + "sectionLst",
                new XElement(
                    sections + "section",
                    new XElement(
                        sections + "sldIdLst",
                        new XElement(sections + "sldId", new XAttribute("id", "256"))))));
            Replace(archive, "ppt/presentation.xml", presentation);
        }

        var graph = new PresentationInspector().Inspect(path);

        Assert.Single(graph.Slides);
    }

    [Fact]
    public void InspectorIgnoresMissingNonSlideRelationshipFromSlide()
    {
        var path = TestPresentationFactory.Create(directory);
        AddInternalRelationship(
            path,
            "ppt/slides/_rels/slide1.xml.rels",
            "rIdMissingAudio",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
            "../media/missing-audio.wav");

        var graph = new PresentationInspector().Inspect(path);

        Assert.Single(graph.Slides);
        Assert.Equal("원본 제목", Assert.Single(graph.Slides[0].Elements).Text);
        Assert.Contains(graph.Warnings, warning => warning.Contains("내부 관계 1개", StringComparison.Ordinal));
    }

    [Fact]
    public void InspectorNamesGraphicFrameKindsAndLinkedChartData()
    {
        var path = TestPresentationFactory.Create(directory);
        XNamespace p = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace a = "http://schemas.openxmlformats.org/drawingml/2006/main";
        XNamespace r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        XNamespace c = "http://schemas.openxmlformats.org/drawingml/2006/chart";
        XElement Frame(uint id, string name, string uri, params object[] data) => new(
            p + "graphicFrame",
            new XElement(p + "nvGraphicFramePr",
                new XElement(p + "cNvPr", new XAttribute("id", id), new XAttribute("name", name)),
                new XElement(p + "cNvGraphicFramePr"),
                new XElement(p + "nvPr")),
            new XElement(p + "xfrm",
                new XElement(a + "off", new XAttribute("x", 0), new XAttribute("y", 0)),
                new XElement(a + "ext", new XAttribute("cx", 914400), new XAttribute("cy", 914400))),
            new XElement(a + "graphic", new XElement(a + "graphicData", new XAttribute("uri", uri), data)));
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Update))
        {
            var slide = ReadXml(archive, "ppt/slides/slide1.xml");
            slide.Descendants(p + "spTree").Single().Add(
                Frame(10, "Table", "http://schemas.openxmlformats.org/drawingml/2006/table", new XElement(a + "tbl")),
                Frame(11, "Linked Chart", "http://schemas.openxmlformats.org/drawingml/2006/chart",
                    new XElement(c + "chart", new XAttribute(r + "id", "rIdChart"))),
                Frame(12, "Diagram", "http://schemas.openxmlformats.org/drawingml/2006/diagram"),
                Frame(13, "Embedded Workbook", "http://schemas.openxmlformats.org/presentationml/2006/ole"));
            Replace(archive, "ppt/slides/slide1.xml", slide);
            Write(archive, "ppt/charts/chart1.xml",
                $"""<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="{c}" xmlns:r="{r}"><c:externalData r:id="rIdData"/></c:chartSpace>""");
            Write(archive, "ppt/charts/_rels/chart1.xml.rels",
                """<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdData" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="file:///C:/data/sales.xlsx" TargetMode="External"/></Relationships>""");
        }
        AddInternalRelationship(
            path,
            "ppt/slides/_rels/slide1.xml.rels",
            "rIdChart",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
            "../charts/chart1.xml");

        var elements = new PresentationInspector().Inspect(path).Slides[0].Elements;

        Assert.Null(elements.Single(element => element.Name == "Title Box").GraphicKind);
        Assert.Equal("table", elements.Single(element => element.Name == "Table").GraphicKind);
        var chart = elements.Single(element => element.Name == "Linked Chart");
        Assert.Equal("chart", chart.GraphicKind);
        Assert.True(chart.ExternalData);
        Assert.Equal("diagram", elements.Single(element => element.Name == "Diagram").GraphicKind);
        Assert.Equal("ole", elements.Single(element => element.Name == "Embedded Workbook").GraphicKind);
    }

    [Fact]
    public void InspectorKeepsGradeAWhenEveryDeclaredFontIsInstalled()
    {
        var path = TestPresentationFactory.Create(directory, fontFamily: "Fixture Sans");
        var environment = new RendererFontEnvironment(true, ["Fixture Sans, Fixture Sans Regular"]);
        var graph = new PresentationInspector(environment).Inspect(path);

        Assert.True(graph.FontInventoryAvailable);
        Assert.Equal(["Fixture Sans"], graph.DeclaredFonts);
        Assert.Empty(graph.MissingFonts);
        Assert.Equal("A", Assert.Single(graph.Slides).SupportGrade);
    }

    [Fact]
    public void InspectorDowngradesEverySlideWhenADeclaredFontIsMissing()
    {
        var path = TestPresentationFactory.Create(directory, fontFamily: "Missing Corporate Font");
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"]);
        var graph = new PresentationInspector(environment).Inspect(path);

        Assert.Equal(["Missing Corporate Font"], graph.MissingFonts);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
        Assert.Contains(graph.Warnings, warning => warning.Contains("Missing Corporate Font", StringComparison.Ordinal));
    }

    [Fact]
    public void InspectorReportsTheEffectiveFallbackForMissingFonts()
    {
        var path = TestPresentationFactory.Create(directory, fontFamily: "Missing Corporate Font");
        var environment = new RendererFontEnvironment(
            true,
            ["Liberation Sans"],
            family => family == "Missing Corporate Font" ? "Liberation Sans" : null);

        var graph = new PresentationInspector(environment).Inspect(path);

        var substitution = Assert.Single(graph.FontSubstitutions);
        Assert.Equal("Missing Corporate Font", substitution.Original);
        Assert.Equal("Liberation Sans", substitution.Substituted);
        Assert.Contains(graph.Warnings, warning => warning.Contains("Missing Corporate Font→Liberation Sans", StringComparison.Ordinal));
    }

    [Fact]
    public void InspectorUsesEditableEmbeddedFontsAndExtractorKeepsThemTemporary()
    {
        const string family = "Embedded Fixture Sans";
        var path = TestPresentationFactory.Create(directory, fontFamily: family);
        AddEmbeddedFont(path, family, permissions: 0x0008);
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"]);

        var graph = new PresentationInspector(environment).Inspect(path);
        var fontDirectory = Path.Combine(directory, "embedded-fonts");
        var extracted = new PptxEmbeddedFontExtractor()
            .ExtractFacesToDirectory(path, fontDirectory);

        Assert.Empty(graph.MissingFonts);
        Assert.Equal("A", Assert.Single(graph.Slides).SupportGrade);
        var extractedFace = Assert.Single(extracted);
        Assert.Equal(family, extractedFace.Typeface);
        Assert.Equal("regular", extractedFace.Style);
        var extractedPath = extractedFace.Path;
        Assert.StartsWith(fontDirectory, extractedPath, StringComparison.Ordinal);
        Assert.True(File.Exists(extractedPath));
        Assert.Equal([0x00, 0x01, 0x00, 0x00], File.ReadAllBytes(extractedPath)[..4]);
    }

    [Fact]
    public void InspectorDoesNotTreatPreservedEmbeddedFontsAsLoadedByAnUnsupportedRenderer()
    {
        const string family = "Embedded Fixture Sans";
        var path = TestPresentationFactory.Create(directory, fontFamily: family);
        AddEmbeddedFont(path, family, permissions: 0x0008);
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"], embeddedFontsSupported: false);

        var graph = new PresentationInspector(environment).Inspect(path);

        Assert.Equal([family], graph.MissingFonts);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
    }

    [Fact]
    public void InspectorDoesNotInstallPreviewOnlyEmbeddedFontsForEditing()
    {
        const string family = "Preview Only Fixture Sans";
        var path = TestPresentationFactory.Create(directory, fontFamily: family);
        AddEmbeddedFont(path, family, permissions: 0x0004);
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"]);

        var graph = new PresentationInspector(environment).Inspect(path);
        var extracted = new PptxEmbeddedFontExtractor()
            .ExtractToDirectory(path, Path.Combine(directory, "preview-only-fonts"));

        Assert.Equal([family], graph.MissingFonts);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
        Assert.Empty(extracted);
    }

    [Fact]
    public void InspectorDoesNotInstallLatinOnlyFontsAssignedToEastAsianText()
    {
        const string family = "Latin Only Fixture Sans";
        var path = TestPresentationFactory.Create(directory, fontFamily: family);
        AddEmbeddedFont(path, family, permissions: 0x0008, supportsHangul: false);
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"]);

        var graph = new PresentationInspector(environment).Inspect(path);
        var extracted = new PptxEmbeddedFontExtractor()
            .ExtractToDirectory(path, Path.Combine(directory, "latin-only-fonts"));

        Assert.Equal([family], graph.MissingFonts);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
        Assert.Empty(extracted);
    }

    [Fact]
    public void InspectorUsesLatinOnlyEmbeddedFontsForLatinText()
    {
        const string family = "Latin Fixture Sans";
        var path = TestPresentationFactory.Create(directory, text: "Blue-Sky Thinking", fontFamily: family);
        AddEmbeddedFont(path, family, permissions: 0x0008, supportsHangul: false);
        var environment = new RendererFontEnvironment(true, ["Liberation Sans"]);

        var graph = new PresentationInspector(environment).Inspect(path);
        var extracted = new PptxEmbeddedFontExtractor()
            .ExtractToDirectory(path, Path.Combine(directory, "latin-fonts"));

        Assert.Empty(graph.MissingFonts);
        Assert.Equal("A", Assert.Single(graph.Slides).SupportGrade);
        Assert.Single(extracted);
    }

    [Fact]
    public void InspectorDowngradesWhenRendererFontInventoryIsUnavailable()
    {
        var path = TestPresentationFactory.Create(directory, fontFamily: "Fixture Sans");
        var graph = new PresentationInspector(new RendererFontEnvironment(false, [])).Inspect(path);

        Assert.False(graph.FontInventoryAvailable);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
        Assert.Contains(graph.Warnings, warning => warning.Contains("판정할 수 없습니다", StringComparison.Ordinal));
    }

    [Fact]
    public void ScannerRejectsZipTraversalEntry()
    {
        var path = Path.Combine(directory, "unsafe.pptx");
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            Write(archive, "[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\" />");
            Write(archive, "ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" />");
            Write(archive, "../escape.txt", "bad");
        }

        Assert.Throws<InvalidDataException>(() => new PptxSafetyScanner().Scan(path));
    }

    [Fact]
    public void ScannerKeepsPassiveHyperlinksWithoutDowngradingTheSlide()
    {
        var path = TestPresentationFactory.Create(directory);
        AddExternalRelationship(
            path,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            "https://example.com/reference");
        var scan = new PptxSafetyScanner().Scan(path);
        var graph = new PresentationInspector(new RendererFontEnvironment(true, ["Fixture Sans"]))
            .Inspect(path, scan);

        Assert.True(scan.HasExternalRelationships);
        Assert.Empty(scan.RiskyExternalRelationshipSourceParts);
        Assert.Equal("A", Assert.Single(graph.Slides).SupportGrade);
        Assert.Contains(graph.Warnings, warning => warning.Contains("하이퍼링크", StringComparison.Ordinal));
    }

    [Fact]
    public void ScannerDowngradesOnlySlidesWithExternalLinkedContent()
    {
        var path = TestPresentationFactory.Create(directory);
        AddExternalRelationship(
            path,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
            "file:///C:/media/linked-video.wmv");
        var scan = new PptxSafetyScanner().Scan(path);
        var graph = new PresentationInspector(new RendererFontEnvironment(true, ["Fixture Sans"]))
            .Inspect(path, scan);

        Assert.True(scan.HasExternalRelationships);
        Assert.Equal(["ppt/slides/slide1.xml"], scan.RiskyExternalRelationshipSourceParts);
        var slide = Assert.Single(graph.Slides);
        Assert.Equal("B", slide.SupportGrade);
        Assert.Contains(slide.Warnings, warning => warning.Contains("외부 연결 콘텐츠", StringComparison.Ordinal));
    }

    private static void Write(ZipArchive archive, string path, string value)
    {
        var entry = archive.CreateEntry(path);
        using var stream = entry.Open();
        stream.Write(Encoding.UTF8.GetBytes(value));
    }

    private static void Write(ZipArchive archive, string path, byte[] value)
    {
        var entry = archive.CreateEntry(path);
        using var stream = entry.Open();
        stream.Write(value);
    }

    private static void AddEmbeddedFont(
        string path,
        string family,
        ushort permissions,
        bool supportsHangul = true)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace presentationNamespace = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        var presentation = ReadXml(archive, "ppt/presentation.xml");
        presentation.Root?.Add(new XElement(
            presentationNamespace + "embeddedFontLst",
            new XElement(
                presentationNamespace + "embeddedFont",
                new XElement(presentationNamespace + "font", new XAttribute("typeface", family)),
                new XElement(
                    presentationNamespace + "regular",
                    new XAttribute(officeRelationships + "id", "rIdEmbeddedFont")))));
        Replace(archive, "ppt/presentation.xml", presentation);

        var relationships = ReadXml(archive, "ppt/_rels/presentation.xml.rels");
        relationships.Root?.Add(new XElement(
            packageRelationships + "Relationship",
            new XAttribute("Id", "rIdEmbeddedFont"),
            new XAttribute(
                "Type",
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"),
            new XAttribute("Target", "fonts/font1.fntdata")));
        Replace(archive, "ppt/_rels/presentation.xml.rels", relationships);

        XNamespace contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
        var types = ReadXml(archive, "[Content_Types].xml");
        types.Root?.Add(new XElement(
            contentTypes + "Default",
            new XAttribute("Extension", "fntdata"),
            new XAttribute("ContentType", "application/x-fontdata")));
        Replace(archive, "[Content_Types].xml", types);
        Write(archive, "ppt/fonts/font1.fntdata", CreateUncompressedEot(permissions, supportsHangul));
    }

    private static void AddExternalRelationship(string path, string type, string target)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        var relationshipPath = "ppt/slides/_rels/slide1.xml.rels";
        var relationships = archive.GetEntry(relationshipPath) is null
            ? new XDocument(new XElement(packageRelationships + "Relationships"))
            : ReadXml(archive, relationshipPath);
        relationships.Root?.Add(new XElement(
            packageRelationships + "Relationship",
            new XAttribute("Id", "rIdExternal"),
            new XAttribute("Type", type),
            new XAttribute("Target", target),
            new XAttribute("TargetMode", "External")));
        Replace(archive, relationshipPath, relationships);
    }

    private static void AddInternalRelationship(
        string path,
        string relationshipPath,
        string id,
        string type,
        string target)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        var relationships = archive.GetEntry(relationshipPath) is null
            ? new XDocument(new XElement(packageRelationships + "Relationships"))
            : ReadXml(archive, relationshipPath);
        relationships.Root?.Add(new XElement(
            packageRelationships + "Relationship",
            new XAttribute("Id", id),
            new XAttribute("Type", type),
            new XAttribute("Target", target)));
        Replace(archive, relationshipPath, relationships);
    }

    private static void AddActiveXFixture(string path)
    {
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        XNamespace officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        XNamespace contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        var slide = ReadXml(archive, "ppt/slides/slide1.xml");
        var commonSlide = slide.Root!.Element(presentation + "cSld")!;
        var controls = new XElement(
            presentation + "controls",
            new XElement(
                presentation + "control",
                new XAttribute("name", "CheckBox1"),
                new XAttribute(officeRelationships + "id", "rIdActiveX"),
                new XElement(
                    presentation + "pic",
                    new XElement(
                        presentation + "blipFill",
                        new XElement(drawing + "blip", new XAttribute(officeRelationships + "embed", "rIdControlImage"))))));
        var extensions = commonSlide.Element(presentation + "extLst");
        if (extensions is null) commonSlide.Add(controls);
        else extensions.AddBeforeSelf(controls);
        Replace(archive, "ppt/slides/slide1.xml", slide);

        var slideRelationships = archive.GetEntry("ppt/slides/_rels/slide1.xml.rels") is null
            ? new XDocument(new XElement(packageRelationships + "Relationships"))
            : ReadXml(archive, "ppt/slides/_rels/slide1.xml.rels");
        slideRelationships.Root!.Add(
            new XElement(packageRelationships + "Relationship",
                new XAttribute("Id", "rIdActiveX"),
                new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/control"),
                new XAttribute("Target", "../activeX/activeX1.xml")),
            new XElement(packageRelationships + "Relationship",
                new XAttribute("Id", "rIdControlImage"),
                new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"),
                new XAttribute("Target", "../media/control1.wmf")),
            new XElement(packageRelationships + "Relationship",
                new XAttribute("Id", "rIdVml"),
                new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing"),
                new XAttribute("Target", "../drawings/vmlDrawing1.vml")));
        Replace(archive, "ppt/slides/_rels/slide1.xml.rels", slideRelationships);

        Write(archive, "ppt/activeX/activeX1.xml", "<ax:ocx xmlns:ax=\"http://schemas.microsoft.com/office/2006/activeX\" r:id=\"rId1\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" />");
        Write(archive, "ppt/activeX/activeX1.bin", [1, 2, 3, 4]);
        Write(archive, "ppt/activeX/_rels/activeX1.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.microsoft.com/office/2006/relationships/activeXControlBinary\" Target=\"activeX1.bin\" /></Relationships>");
        Write(archive, "ppt/media/control1.wmf", [5, 6, 7, 8]);
        Write(archive, "ppt/drawings/vmlDrawing1.vml", "<xml xmlns:v=\"urn:schemas-microsoft-com:vml\"><v:shape id=\"control1\" /></xml>");
        Write(archive, "ppt/drawings/_rels/vmlDrawing1.vml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/control1.wmf\" /></Relationships>");

        var types = ReadXml(archive, "[Content_Types].xml");
        types.Root!.Add(
            new XElement(contentTypes + "Default", new XAttribute("Extension", "bin"), new XAttribute("ContentType", "application/vnd.ms-office.activeX")),
            new XElement(contentTypes + "Default", new XAttribute("Extension", "wmf"), new XAttribute("ContentType", "image/x-wmf")),
            new XElement(contentTypes + "Default", new XAttribute("Extension", "vml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.vmlDrawing")),
            new XElement(contentTypes + "Override", new XAttribute("PartName", "/ppt/activeX/activeX1.xml"), new XAttribute("ContentType", "application/vnd.ms-office.activeX+xml")));
        Replace(archive, "[Content_Types].xml", types);
    }

    private static void AddUnsupportedPresentationFeatureFixture(string path)
    {
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        XNamespace contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        var relationships = ReadXml(archive, "ppt/_rels/presentation.xml.rels");
        relationships.Root!.Add(
            new XElement(
                packageRelationships + "Relationship",
                new XAttribute("Id", "rIdPrinterSettings"),
                new XAttribute(
                    "Type",
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings"),
                new XAttribute("Target", "printerSettings/printerSettings1.bin")),
            new XElement(
                packageRelationships + "Relationship",
                new XAttribute("Id", "rIdTableStyles"),
                new XAttribute(
                    "Type",
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles"),
                new XAttribute("Target", "tableStyles.xml")));
        Replace(archive, "ppt/_rels/presentation.xml.rels", relationships);

        Write(archive, "ppt/printerSettings/printerSettings1.bin", [1, 3, 5, 7]);
        Write(
            archive,
            "ppt/tableStyles.xml",
            "<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}\" />");
        var types = ReadXml(archive, "[Content_Types].xml");
        types.Root!.Add(
            new XElement(
                contentTypes + "Override",
                new XAttribute("PartName", "/ppt/printerSettings/printerSettings1.bin"),
                new XAttribute(
                    "ContentType",
                    "application/vnd.openxmlformats-officedocument.presentationml.printerSettings")),
            new XElement(
                contentTypes + "Override",
                new XAttribute("PartName", "/ppt/tableStyles.xml"),
                new XAttribute(
                    "ContentType",
                    "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml")));
        Replace(archive, "[Content_Types].xml", types);
    }

    private static void StripUnsupportedPresentationFeatureFixture(string path)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        archive.GetEntry("ppt/printerSettings/printerSettings1.bin")!.Delete();
        archive.GetEntry("ppt/tableStyles.xml")!.Delete();
        var relationships = ReadXml(archive, "ppt/_rels/presentation.xml.rels");
        relationships.Root!.Elements()
            .Where(element =>
                ((string?)element.Attribute("Type"))?.EndsWith("/printerSettings", StringComparison.Ordinal) == true
                || ((string?)element.Attribute("Type"))?.EndsWith("/tableStyles", StringComparison.Ordinal) == true)
            .Remove();
        Replace(archive, "ppt/_rels/presentation.xml.rels", relationships);
        var types = ReadXml(archive, "[Content_Types].xml");
        types.Root!.Elements()
            .Where(element => (string?)element.Attribute("PartName") is
                "/ppt/printerSettings/printerSettings1.bin" or "/ppt/tableStyles.xml")
            .Remove();
        Replace(archive, "[Content_Types].xml", types);
    }

    private static void StripActiveXFixture(string path)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        foreach (var entry in archive.Entries
            .Where(entry => entry.FullName.StartsWith("ppt/activeX/", StringComparison.Ordinal)
                || entry.FullName.StartsWith("ppt/drawings/", StringComparison.Ordinal)
                || entry.FullName == "ppt/media/control1.wmf")
            .ToList())
            entry.Delete();
        var slide = ReadXml(archive, "ppt/slides/slide1.xml");
        slide.Descendants().First(element => element.Name.LocalName == "controls").Remove();
        Replace(archive, "ppt/slides/slide1.xml", slide);
        var relationships = ReadXml(archive, "ppt/slides/_rels/slide1.xml.rels");
        relationships.Root!.Elements()
            .Where(element => new[] { "rIdActiveX", "rIdControlImage", "rIdVml" }.Contains((string?)element.Attribute("Id")))
            .Remove();
        Replace(archive, "ppt/slides/_rels/slide1.xml.rels", relationships);
        var types = ReadXml(archive, "[Content_Types].xml");
        types.Root!.Elements()
            .Where(element => new[] { "bin", "wmf", "vml" }.Contains((string?)element.Attribute("Extension"))
                || (string?)element.Attribute("PartName") == "/ppt/activeX/activeX1.xml")
            .Remove();
        Replace(archive, "[Content_Types].xml", types);
    }

    private static byte[] CreateUncompressedEot(ushort permissions, bool supportsHangul)
    {
        var sfnt = CreateSfnt(supportsHangul ? 0xac00u : 0x0041u);
        var eot = new byte[36 + sfnt.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(eot.AsSpan(0, 4), checked((uint)eot.Length));
        BinaryPrimitives.WriteUInt32LittleEndian(eot.AsSpan(4, 4), checked((uint)sfnt.Length));
        BinaryPrimitives.WriteUInt32LittleEndian(eot.AsSpan(8, 4), 0x00020002);
        BinaryPrimitives.WriteUInt16LittleEndian(eot.AsSpan(32, 2), permissions);
        BinaryPrimitives.WriteUInt16LittleEndian(eot.AsSpan(34, 2), 0x504c);
        sfnt.CopyTo(eot, 36);
        return eot;
    }

    private static byte[] CreateSfnt(uint codePoint)
    {
        const int tableDirectorySize = 28;
        const int cmapSize = 40;
        var sfnt = new byte[tableDirectorySize + cmapSize];
        BinaryPrimitives.WriteUInt32BigEndian(sfnt.AsSpan(0, 4), 0x00010000);
        BinaryPrimitives.WriteUInt16BigEndian(sfnt.AsSpan(4, 2), 1);
        "cmap"u8.CopyTo(sfnt.AsSpan(12, 4));
        BinaryPrimitives.WriteUInt32BigEndian(sfnt.AsSpan(20, 4), tableDirectorySize);
        BinaryPrimitives.WriteUInt32BigEndian(sfnt.AsSpan(24, 4), cmapSize);

        var cmap = sfnt.AsSpan(tableDirectorySize);
        BinaryPrimitives.WriteUInt16BigEndian(cmap.Slice(2, 2), 1);
        BinaryPrimitives.WriteUInt16BigEndian(cmap.Slice(4, 2), 3);
        BinaryPrimitives.WriteUInt16BigEndian(cmap.Slice(6, 2), 10);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(8, 4), 12);
        BinaryPrimitives.WriteUInt16BigEndian(cmap.Slice(12, 2), 12);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(16, 4), 28);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(24, 4), 1);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(28, 4), codePoint);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(32, 4), codePoint);
        BinaryPrimitives.WriteUInt32BigEndian(cmap.Slice(36, 4), 1);
        return sfnt;
    }

    private static void Replace(ZipArchive archive, string path, XDocument document)
    {
        archive.GetEntry(path)?.Delete();
        var entry = archive.CreateEntry(path);
        using var stream = entry.Open();
        document.Save(stream, SaveOptions.DisableFormatting);
    }

    private static XDocument ReadXml(ZipArchive archive, string path)
    {
        var entry = archive.GetEntry(path)
            ?? throw new InvalidDataException($"Missing test archive entry: {path}");
        using var stream = entry.Open();
        return XDocument.Load(stream);
    }

    public void Dispose()
    {
        Directory.Delete(directory, true);
        GC.SuppressFinalize(this);
    }
}
