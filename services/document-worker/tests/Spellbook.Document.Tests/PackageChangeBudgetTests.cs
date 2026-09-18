using System.IO.Compression;
using System.Text.Json;
using System.Xml.Linq;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class PackageChangeBudgetTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        $"spellbook-change-budget-tests-{Guid.NewGuid():N}");

    public PackageChangeBudgetTests() => Directory.CreateDirectory(directory);

    [Fact]
    public void AllowsOnlyTheDeclaredCategoryAndTargetSlide()
    {
        var source = TestPresentationFactory.Create(directory);
        var twoSlides = Path.Combine(directory, "two-slides.pptx");
        var addSlide = new EditCommandBatch(
            ContractVersions.Current,
            Hashing.FileSha256(source),
            "add fixture slide",
            [JsonSerializer.SerializeToElement(new
            {
                op = "duplicate_slide",
                slideIndex = 0,
                insertIndex = 1
            })]);
        var created = new PptxPatcher().Apply(source, twoSlides, addSlide);
        Assert.True(created.Validation.Valid, string.Join("\n", created.Validation.Errors));

        var target = created.CandidateGraph.Slides[1].Elements[0];
        var candidate = Path.Combine(directory, "second-slide-edited.pptx");
        var edit = new EditCommandBatch(
            ContractVersions.Current,
            Hashing.FileSha256(twoSlides),
            "edit second slide",
            [JsonSerializer.SerializeToElement(new
            {
                op = "replace_text",
                target = new
                {
                    slideIndex = 1,
                    elementId = target.ElementId,
                    sourceHash = target.SourceHash
                },
                text = "두 번째 슬라이드만 변경"
            })]);
        var changed = new PptxPatcher().Apply(twoSlides, candidate, edit);
        Assert.True(changed.Validation.Valid, string.Join("\n", changed.Validation.Errors));
        var validator = new PptxPackageChangeBudgetValidator();

        var accepted = validator.Validate(
            twoSlides,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["slide_parts"], [1]));
        var rejected = validator.Validate(
            twoSlides,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["slide_parts"], [0]));

        Assert.True(accepted.Valid, string.Join("\n", accepted.Errors));
        Assert.Single(accepted.Changes);
        Assert.Equal(
            created.CandidateGraph.Slides[1].PartUri.TrimStart('/'),
            accepted.Changes[0].Part);
        Assert.Equal("slide_parts", accepted.Changes[0].Category);
        Assert.False(rejected.Valid);
        Assert.Contains(
            rejected.Errors,
            error => error.Contains("outside the targeted slide scope"));
    }

    [Fact]
    public void RejectsUndeclaredPartsAndPartCreation()
    {
        var baseline = TestPresentationFactory.Create(directory);
        var candidate = Path.Combine(directory, "unexpected-part.pptx");
        File.Copy(baseline, candidate);
        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            using var output = archive.CreateEntry("customXml/item1.xml").Open();
            output.Write("<unexpected/>"u8);
        }

        var report = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["slide_parts"]));

        Assert.False(report.Valid);
        Assert.Equal("custom_xml", Assert.Single(report.Changes).Category);
        Assert.Contains(
            report.Errors,
            error => error.Contains("exceeds the declared change budget"));
        Assert.Contains(
            report.Errors,
            error => error.Contains("without creation/deletion authority"));
    }

    [Fact]
    public void IgnoresOnlyVolatileOfficeSaveMetadata()
    {
        var source = TestPresentationFactory.Create(directory);
        var baseline = Path.Combine(directory, "volatile-baseline.pptx");
        var candidate = Path.Combine(directory, "volatile-candidate.pptx");
        File.Copy(source, baseline);
        File.Copy(source, candidate);
        AddOfficeSaveMetadata(
            baseline,
            "11111111-1111-1111-1111-111111111111",
            "1",
            "2026-01-01T00:00:00Z",
            "1",
            "<#>");
        AddOfficeSaveMetadata(
            candidate,
            "22222222-2222-2222-2222-222222222222",
            "2",
            "2026-02-02T00:00:00Z",
            "9",
            "<#>");

        var ignored = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.True(ignored.Valid, string.Join("\n", ignored.Errors));
        Assert.Empty(ignored.Changes);

        var changedApplication = Path.Combine(directory, "changed-application.pptx");
        File.Copy(candidate, changedApplication);
        using (var archive = ZipFile.Open(changedApplication, ZipArchiveMode.Update))
        {
            var app = ReadXml(archive, "docProps/app.xml");
            XNamespace extended =
                "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
            app.Descendants(extended + "Application").Single().Value = "Unexpected editor";
            Replace(archive, "docProps/app.xml", app);
        }
        var documentPropertyChange = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            changedApplication,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.False(documentPropertyChange.Valid);
        Assert.Equal("document_properties", Assert.Single(documentPropertyChange.Changes).Category);

        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            var slide = ReadXml(archive, "ppt/slides/slide1.xml");
            XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
            slide.Descendants(drawing + "t").Last().Value = "changed";
            Replace(archive, "ppt/slides/slide1.xml", slide);
        }
        var semanticChange = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.False(semanticChange.Valid);
        Assert.Equal("slide_parts", Assert.Single(semanticChange.Changes).Category);
    }

    [Fact]
    public void IgnoresCollaboraPageGuidValuesButNotTheirStructure()
    {
        var source = TestPresentationFactory.Create(directory);
        var baseline = Path.Combine(directory, "page-guid-baseline.pptx");
        var candidate = Path.Combine(directory, "page-guid-candidate.pptx");
        File.Copy(source, baseline);
        File.Copy(source, candidate);
        AddCollaboraPageGuid(baseline, "11111111-1111-1111-1111-111111111111");
        AddCollaboraPageGuid(candidate, "22222222-2222-2222-2222-222222222222");

        var ignored = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.True(ignored.Valid, string.Join("\n", ignored.Errors));
        Assert.Empty(ignored.Changes);

        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            var part = "ppt/slideMasters/slideMaster1.xml";
            var master = ReadXml(archive, part);
            XNamespace collabora =
                "urn:com:collaboraoffice:names:experimental:ooxml:xmlns:coext:1.0";
            master.Descendants(collabora + "pageGuid").Single()
                .SetAttributeValue("purpose", "semantic-change");
            Replace(archive, part, master);
        }

        var semanticChange = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.False(semanticChange.Valid);
        Assert.Equal("slide_master_parts", Assert.Single(semanticChange.Changes).Category);
    }

    [Fact]
    public void IgnoresRandomChartAxisIdsButNotAxisLinks()
    {
        var source = TestPresentationFactory.Create(directory);
        var baseline = Path.Combine(directory, "chart-axis-baseline.pptx");
        var candidate = Path.Combine(directory, "chart-axis-candidate.pptx");
        File.Copy(source, baseline);
        File.Copy(source, candidate);
        AddChart(baseline, "40817986", "18128015", crossFirst: "18128015");
        AddChart(candidate, "79433342", "37366181", crossFirst: "37366181");

        var ignored = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["slide_parts"], [0]));
        Assert.True(ignored.Valid, string.Join("\n", ignored.Errors));
        Assert.Empty(ignored.Changes);

        // The first axis now crosses itself: a real change to the chart.
        AddChart(candidate, "79433342", "37366181", crossFirst: "79433342");
        var relinked = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["slide_parts"], [0]));
        Assert.False(relinked.Valid);
        Assert.Equal("chart_parts", Assert.Single(relinked.Changes).Category);
    }

    private static void AddChart(string path, string first, string second, string crossFirst)
    {
        XNamespace chart = "http://schemas.openxmlformats.org/drawingml/2006/chart";
        var document = new XDocument(
            new XElement(
                chart + "chartSpace",
                new XElement(
                    chart + "chart",
                    new XElement(
                        chart + "plotArea",
                        new XElement(
                            chart + "barChart",
                            new XElement(chart + "axId", new XAttribute("val", first)),
                            new XElement(chart + "axId", new XAttribute("val", second))),
                        new XElement(
                            chart + "catAx",
                            new XElement(chart + "axId", new XAttribute("val", first)),
                            new XElement(chart + "crossAx", new XAttribute("val", crossFirst))),
                        new XElement(
                            chart + "valAx",
                            new XElement(chart + "axId", new XAttribute("val", second)),
                            new XElement(chart + "crossAx", new XAttribute("val", first)))))));
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        Replace(archive, "ppt/charts/chart1.xml", document);
    }

    [Fact]
    public void IgnoresSlideLayoutObjectRenumberingButNotPlaceholderChanges()
    {
        var source = TestPresentationFactory.Create(directory);
        var baseline = Path.Combine(directory, "layout-id-baseline.pptx");
        var candidate = Path.Combine(directory, "layout-id-candidate.pptx");
        File.Copy(source, baseline);
        File.Copy(source, candidate);
        AddSlideLayoutFixture(baseline);
        AddSlideLayoutFixture(candidate);
        RenumberNonVisualObjectIds(baseline, "ppt/slideLayouts/", 100);
        RenumberNonVisualObjectIds(candidate, "ppt/slideLayouts/", 900);

        var ignored = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.True(ignored.Valid, string.Join("\n", ignored.Errors));
        Assert.Empty(ignored.Changes);

        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            var part = FirstXmlPart(archive, "ppt/slideLayouts/");
            var layout = ReadXml(archive, part);
            XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
            XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
            var shapeTree = layout.Descendants(presentation + "spTree").Single();
            shapeTree.Add(
                new XElement(
                    presentation + "sp",
                    new XElement(
                        presentation + "nvSpPr",
                        new XElement(
                            presentation + "cNvPr",
                            new XAttribute("id", "9999"),
                            new XAttribute("name", "Added body placeholder")),
                        new XElement(presentation + "cNvSpPr"),
                        new XElement(
                            presentation + "nvPr",
                            new XElement(presentation + "ph", new XAttribute("type", "body")))),
                    new XElement(presentation + "spPr"),
                    new XElement(
                        presentation + "txBody",
                        new XElement(drawing + "bodyPr"),
                        new XElement(drawing + "lstStyle"),
                        new XElement(drawing + "p"))));
            Replace(archive, part, layout);
        }

        var semanticChange = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.False(semanticChange.Valid);
        Assert.Equal("slide_layout_parts", Assert.Single(semanticChange.Changes).Category);
    }

    [Fact]
    public void IgnoresOnlyMasterLayoutDynamicPlaceholderCacheText()
    {
        var source = TestPresentationFactory.Create(directory);
        var baseline = Path.Combine(directory, "placeholder-cache-baseline.pptx");
        var candidate = Path.Combine(directory, "placeholder-cache-candidate.pptx");
        File.Copy(source, baseline);
        File.Copy(source, candidate);
        AddSlideLayoutFixture(baseline);
        AddSlideLayoutFixture(candidate);
        AddDynamicLayoutPlaceholders(baseline, "<date/time>", "<footer>", "<number>");
        AddDynamicLayoutPlaceholders(candidate, " ", " ", "1");

        var ignored = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.True(ignored.Valid, string.Join("\n", ignored.Errors));
        Assert.Empty(ignored.Changes);

        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            var part = FirstXmlPart(archive, "ppt/slideLayouts/");
            var layout = ReadXml(archive, part);
            XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
            layout.Descendants(presentation + "ph")
                .Single(element => (string?)element.Attribute("type") == "sldNum")
                .SetAttributeValue("type", "body");
            Replace(archive, part, layout);
        }

        var semanticChange = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));
        Assert.False(semanticChange.Valid);
        Assert.Equal("slide_layout_parts", Assert.Single(semanticChange.Changes).Category);
    }

    [Fact]
    public void KeepsSlideObjectIdsExactBecauseAnimationsCanTargetThem()
    {
        var baseline = TestPresentationFactory.Create(directory);
        var candidate = Path.Combine(directory, "slide-object-id-candidate.pptx");
        File.Copy(baseline, candidate);
        RenumberNonVisualObjectIds(candidate, "ppt/slides/", 900);

        var report = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, []));

        Assert.False(report.Valid);
        Assert.Equal("slide_parts", Assert.Single(report.Changes).Category);
    }

    [Fact]
    public void PartCreationRequiresBothAnAllowedCategoryAndExplicitAuthority()
    {
        var baseline = TestPresentationFactory.Create(directory);
        var candidate = Path.Combine(directory, "notes-master-candidate.pptx");
        File.Copy(baseline, candidate);
        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            using var output = archive.CreateEntry("ppt/notesMasters/notesMaster1.xml").Open();
            output.Write("<p:notesMaster xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>"u8);
        }

        var denied = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(ContractVersions.Current, ["notes_master_parts"]));
        var accepted = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            candidate,
            new PackageChangeBudgetRequest(
                ContractVersions.Current,
                ["notes_master_parts"],
                AllowPartCreationOrDeletion: true));

        Assert.False(denied.Valid);
        Assert.Contains(denied.Errors, error => error.Contains("without creation/deletion authority"));
        Assert.True(accepted.Valid, string.Join("\n", accepted.Errors));
    }

    [Theory]
    [InlineData("[Content_Types].xml", "package_manifest")]
    [InlineData("ppt/_rels/presentation.xml.rels", "presentation_relationships")]
    [InlineData("ppt/slides/slide2.xml", "slide_parts")]
    [InlineData("ppt/slides/_rels/slide2.xml.rels", "slide_relationships")]
    [InlineData("ppt/charts/chart1.xml", "chart_parts")]
    [InlineData("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx", "embedded_workbooks")]
    [InlineData("ppt/diagrams/data1.xml", "diagram_parts")]
    [InlineData("mystery.bin", "unknown")]
    public void ClassifiesEveryPackagePartDeterministically(string part, string expected) =>
        Assert.Equal(expected, PptxPackageChangeBudgetValidator.Classify(part));

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, true);
    }

    private static void AddOfficeSaveMetadata(
        string path,
        string fieldId,
        string revision,
        string modified,
        string totalTime,
        string fieldText)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        XNamespace core = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
        XNamespace terms = "http://purl.org/dc/terms/";
        XNamespace xsi = "http://www.w3.org/2001/XMLSchema-instance";
        Replace(
            archive,
            "docProps/core.xml",
            new XDocument(
                new XElement(
                    core + "coreProperties",
                    new XElement(core + "lastModifiedBy", "editor"),
                    new XElement(core + "revision", revision),
                    new XElement(
                        terms + "modified",
                        new XAttribute(xsi + "type", "dcterms:W3CDTF"),
                        modified))));
        XNamespace extended =
            "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
        var app = archive.GetEntry("docProps/app.xml") is null
            ? new XDocument(
                new XElement(
                    extended + "Properties",
                    new XElement(extended + "TotalTime", "0"),
                    new XElement(extended + "Application", "Spellbook test")))
            : ReadXml(archive, "docProps/app.xml");
        app.Descendants(extended + "TotalTime").Single().Value = totalTime;
        Replace(archive, "docProps/app.xml", app);
        var slide = ReadXml(archive, "ppt/slides/slide1.xml");
        slide.Root?.Add(
            new XElement(
                drawing + "fld",
                new XAttribute("id", $"{{{fieldId}}}"),
                new XAttribute("type", "slidenum"),
                new XElement(drawing + "t", fieldText)));
        Replace(archive, "ppt/slides/slide1.xml", slide);
    }

    private static void Replace(ZipArchive archive, string part, XDocument document)
    {
        archive.GetEntry(part)?.Delete();
        var entry = archive.CreateEntry(part);
        using var stream = entry.Open();
        document.Save(stream, SaveOptions.DisableFormatting);
    }

    private static void RenumberNonVisualObjectIds(string path, string partPrefix, int start)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        var part = FirstXmlPart(archive, partPrefix);
        var document = ReadXml(archive, part);
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        var properties = document.Descendants(presentation + "cNvPr").ToArray();
        Assert.NotEmpty(properties);
        for (var index = 0; index < properties.Length; index++)
            properties[index].SetAttributeValue("id", (start + index).ToString());
        Replace(archive, part, document);
    }

    private static void AddSlideLayoutFixture(string path)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        Replace(
            archive,
            "ppt/slideLayouts/slideLayout1.xml",
            new XDocument(
                new XElement(
                    presentation + "sldLayout",
                    new XElement(
                        presentation + "cSld",
                        new XElement(
                            presentation + "spTree",
                            new XElement(
                                presentation + "nvGrpSpPr",
                                new XElement(
                                    presentation + "cNvPr",
                                    new XAttribute("id", "1"),
                                    new XAttribute("name", string.Empty)),
                                new XElement(presentation + "cNvGrpSpPr"),
                                new XElement(presentation + "nvPr")),
                            new XElement(
                                presentation + "grpSpPr",
                                new XElement(drawing + "xfrm")),
                            new XElement(
                                presentation + "sp",
                                new XElement(
                                    presentation + "nvSpPr",
                                    new XElement(
                                        presentation + "cNvPr",
                                        new XAttribute("id", "2"),
                                        new XAttribute("name", "Title 1")),
                                    new XElement(presentation + "cNvSpPr"),
                                    new XElement(
                                        presentation + "nvPr",
                                        new XElement(presentation + "ph", new XAttribute("type", "title")))),
                                new XElement(presentation + "spPr"),
                                new XElement(
                                    presentation + "txBody",
                                    new XElement(drawing + "bodyPr"),
                                    new XElement(drawing + "lstStyle"),
                                new XElement(drawing + "p"))))))));
    }

    private static void AddDynamicLayoutPlaceholders(
        string path,
        string dateText,
        string footerText,
        string slideNumberText)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        var part = FirstXmlPart(archive, "ppt/slideLayouts/");
        var layout = ReadXml(archive, part);
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        var shapeTree = layout.Descendants(presentation + "spTree").Single();
        var placeholders = new[]
        {
            (Type: "dt", FieldType: "datetime", Text: dateText),
            (Type: "ftr", FieldType: (string?)null, Text: footerText),
            (Type: "sldNum", FieldType: "slidenum", Text: slideNumberText),
        };
        foreach (var (type, fieldType, text) in placeholders)
        {
            var textNode = fieldType is null
                ? new XElement(drawing + "r", new XElement(drawing + "t", text))
                : new XElement(
                    drawing + "fld",
                    new XAttribute("id", "{11111111-1111-1111-1111-111111111111}"),
                    new XAttribute("type", fieldType),
                    new XElement(drawing + "t", text));
            shapeTree.Add(
                new XElement(
                    presentation + "sp",
                    new XElement(
                        presentation + "nvSpPr",
                        new XElement(
                            presentation + "cNvPr",
                            new XAttribute("id", (shapeTree.Elements(presentation + "sp").Count() + 10).ToString()),
                            new XAttribute("name", $"{type} placeholder")),
                        new XElement(presentation + "cNvSpPr"),
                        new XElement(
                            presentation + "nvPr",
                            new XElement(presentation + "ph", new XAttribute("type", type)))),
                    new XElement(presentation + "spPr"),
                    new XElement(
                        presentation + "txBody",
                        new XElement(drawing + "bodyPr"),
                        new XElement(drawing + "lstStyle"),
                        new XElement(drawing + "p", textNode))));
        }
        Replace(archive, part, layout);
    }

    private static void AddCollaboraPageGuid(string path, string guid)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Update);
        XNamespace presentation =
            "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace collabora =
            "urn:com:collaboraoffice:names:experimental:ooxml:xmlns:coext:1.0";
        Replace(
            archive,
            "ppt/slideMasters/slideMaster1.xml",
            new XDocument(
                new XElement(
                    presentation + "sldMaster",
                    new XElement(
                        presentation + "extLst",
                        new XElement(
                            presentation + "ext",
                            new XAttribute("uri", collabora.NamespaceName),
                            new XElement(
                                collabora + "pageGuid",
                                new XAttribute("val", $"{{{guid}}}")))))));
    }

    private static string FirstXmlPart(ZipArchive archive, string prefix) => archive.Entries
        .Where(entry =>
            entry.FullName.StartsWith(prefix, StringComparison.Ordinal)
            && entry.FullName.EndsWith(".xml", StringComparison.Ordinal)
            && !entry.FullName.Contains("/_rels/", StringComparison.Ordinal))
        .Select(entry => entry.FullName)
        .Order()
        .First();

    private static XDocument ReadXml(ZipArchive archive, string part)
    {
        var entry = archive.GetEntry(part)
            ?? throw new InvalidDataException($"Missing test archive entry: {part}");
        using var stream = entry.Open();
        return XDocument.Load(stream);
    }
}
