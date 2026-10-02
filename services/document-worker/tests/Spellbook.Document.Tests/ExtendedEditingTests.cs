using System.IO.Compression;
using System.Text.Json;
using System.Xml.Linq;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class ExtendedEditingTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), $"spellbook-edit-{Guid.NewGuid():N}");
    public ExtendedEditingTests() => Directory.CreateDirectory(directory);
    private string Apply(string path, params object[] commands)
    {
        var output = Path.Combine(directory, Guid.NewGuid() + ".pptx");
        var batch = new EditCommandBatch("1.0", Hashing.FileSha256(path), "test", commands.Select(c => JsonSerializer.SerializeToElement(c)).ToArray());
        var result = new PptxPatcher().Apply(path, output, batch);
        Assert.True(result.Validation.Valid, string.Join("\n", result.Validation.Errors));
        return output;
    }
    private static object Target(string path, int slide = 0, int element = 0)
    {
        var e = new PresentationInspector().Inspect(path).Slides[slide].Elements[element];
        return new { slideIndex = slide, elementId = e.ElementId, sourceHash = e.SourceHash };
    }
    [Fact]
    public void CreatesSecondSlideAndEditableTextWithoutChangingFirstSlide()
    {
        var source = TestPresentationFactory.Create(directory);
        var original = Read(source, "ppt/slides/slide1.xml");
        var created = Apply(source, new { op = "add_slide", templateSlideIndex = 0, insertIndex = 1 });
        var written = Apply(created, new { op = "add_text_box", slideIndex = 1, x = 100L, y = 200L, width = 3000000L, height = 900000L, text = "두 번째 슬라이드\n새 텍스트" });
        var graph = new PresentationInspector().Inspect(written);
        Assert.Equal(2, graph.Slides.Count);
        Assert.Equal("두 번째 슬라이드\n새 텍스트", graph.Slides[1].Elements.Single().Text);
        Assert.True(graph.Slides[1].Elements.Single().Editable);
        Assert.Equal(original, Read(written, "ppt/slides/slide1.xml"));
    }
    [Fact]
    public void DuplicateMoveAndDeletePreserveSlideIdentityAndRejectEmptyDeck()
    {
        var source = TestPresentationFactory.Create(directory);
        Assert.Throws<InvalidDataException>(() => Apply(source, new { op = "delete_slide", slideIndex = 0 }));
        var duplicate = Apply(source, new { op = "duplicate_slide", slideIndex = 0, insertIndex = 0 });
        var graph = new PresentationInspector().Inspect(duplicate);
        Assert.Equal(2, graph.Slides.Count);
        Assert.NotEqual(graph.Slides[0].PartUri, graph.Slides[1].PartUri);
        var moved = Apply(duplicate, new { op = "move_slide", slideIndex = 0, insertIndex = 1 });
        Assert.Equal(graph.Slides[0].PartUri, new PresentationInspector().Inspect(moved).Slides[1].PartUri);
        var deleted = Apply(moved, new { op = "delete_slide", slideIndex = 1 });
        Assert.Single(new PresentationInspector().Inspect(deleted).Slides);
    }
    [Fact]
    public void NewShapesSupportStylingDuplicationStackingAndDeletion()
    {
        var source = TestPresentationFactory.Create(directory);
        var created = Apply(source, new { op = "add_shape", slideIndex = 0, x = 100L, y = 100L, width = 1000000L, height = 1000000L, geometry = "ellipse", rgb = "2266AA" });
        var duplicate = Apply(created, new { op = "duplicate_shape", target = Target(created, element: 1), x = 200L, y = 200L });
        var styled = Apply(duplicate,
            new { op = "set_text_style", target = Target(duplicate), fontFamily = "Arial", fontSize = 28, bold = true, italic = true, rgb = "123456" },
            new { op = "set_paragraph_style", target = Target(duplicate), alignment = "center", bullet = "bullet" },
            new { op = "set_line", target = Target(duplicate, element: 1), rgb = "000000", width = 2 },
            new { op = "rotate_shape", target = Target(duplicate, element: 1), degrees = 45 },
            new { op = "reorder_shape", target = Target(duplicate, element: 1), position = "front" });
        Assert.Equal(3, new PresentationInspector().Inspect(styled).Slides[0].Elements.Count);
        var deleted = Apply(styled, new { op = "delete_shape", target = Target(styled, element: 2) });
        Assert.Equal(2, new PresentationInspector().Inspect(deleted).Slides[0].Elements.Count);
    }
    [Fact]
    public void TableCellsAndBackgroundAreEditableWithoutFlatteningTable()
    {
        var source = TestPresentationFactory.Create(directory);
        var table = Apply(source, new { op = "add_table", slideIndex = 0, x = 100L, y = 200L, width = 4000000L, height = 2000000L, rows = new[] { new[] { "A", "B" }, new[] { "C", "D" } } });
        Assert.Equal("http://schemas.openxmlformats.org/drawingml/2006/table", (string?)XDocument.Parse(Read(table, "ppt/slides/slide1.xml")).Descendants().Single(element => element.Name.LocalName == "graphicData").Attribute("uri"));
        var edited = Apply(table, new { op = "set_table_cell", target = Target(table, element: 1), row = 1, column = 0, text = "새 셀" }, new { op = "set_background", slideIndex = 0, rgb = "EEEEEE" });
        Assert.Contains("새 셀", new PresentationInspector().Inspect(edited).Slides[0].Elements[1].Text);
        Assert.Single(XDocument.Parse(Read(edited, "ppt/slides/slide1.xml")).Descendants(), element => element.Name.LocalName == "tbl");
        Assert.Throws<InvalidDataException>(() => Apply(table, new { op = "set_table_cell", target = Target(table, element: 1), row = 8, column = 0, text = "bad" }));
    }
    [Fact]
    public void RejectsAWellFormedTableWithAnUnrecognizedGraphicDataType()
    {
        var source = TestPresentationFactory.Create(directory);
        var table = Apply(source, new { op = "add_table", slideIndex = 0, x = 100L, y = 200L, width = 4000000L, height = 2000000L, rows = new[] { new[] { "A", "B" } } });
        var broken = Path.Combine(directory, "wrong-table-type.pptx");
        File.Copy(table, broken);
        using (var zip = ZipFile.Open(broken, ZipArchiveMode.Update))
        {
            var part = zip.GetEntry("ppt/slides/slide1.xml")!;
            XDocument xml; using (var input = part.Open()) xml = XDocument.Load(input);
            xml.Descendants().Single(e => e.Name.LocalName == "graphicData").SetAttributeValue("uri", "http://schemas.openxmlformats.org/drawingml/2006/main/table");
            part.Delete(); using var output = zip.CreateEntry("ppt/slides/slide1.xml").Open(); xml.Save(output);
        }
        var validation = new PptxValidator().Validate(table, broken, new HashSet<string> { "ppt/slides/slide1.xml" });
        Assert.False(validation.Valid);
        Assert.Contains(validation.Errors, error => error.Contains("table payload"));
    }
    [Fact]
    public void StandaloneOpenXmlValidationReportsSchemaErrors()
    {
        var source = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "../../../../../../../eval/public/fixtures/general-native-surface.pptx"));
        Assert.True(new PptxValidator().ValidateOpenXml(source).Valid);
        var broken = Path.Combine(directory, "invalid-slide-attribute.pptx");
        File.Copy(source, broken);
        using (var zip = ZipFile.Open(broken, ZipArchiveMode.Update))
        {
            var part = zip.GetEntry("ppt/slides/slide1.xml")!;
            XDocument xml; using (var input = part.Open()) xml = XDocument.Load(input);
            xml.Root!.SetAttributeValue("show", "not-a-boolean");
            part.Delete(); using var output = zip.CreateEntry("ppt/slides/slide1.xml").Open(); xml.Save(output);
        }
        var report = new PptxValidator().ValidateOpenXml(broken);
        Assert.False(report.Valid);
        Assert.NotEmpty(report.Errors);
    }
    [Fact]
    public void UnicodeMediaValidationDoesNotRewriteSourceAndStillFindsSchemaErrors()
    {
        var source = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../../../eval/public/downloads/lo-transition-media.pptx"));
        var before = Hashing.FileSha256(source);
        var report = new PptxValidator().ValidateOpenXml(source);
        Assert.True(report.Valid, string.Join("\n", report.Errors));
        Assert.Null(report.Failure);
        Assert.Contains(report.ReaderAdjustments!, change => change.Contains("Cort%C3%A1zar.wav"));
        Assert.Equal(before, Hashing.FileSha256(source));
        var broken = Path.Combine(directory, "unicode-invalid-slide.pptx");
        File.Copy(source, broken);
        using (var zip = ZipFile.Open(broken, ZipArchiveMode.Update))
        {
            var part = zip.GetEntry("ppt/slides/slide1.xml")!;
            XDocument xml; using (var input = part.Open()) xml = XDocument.Load(input);
            xml.Root!.SetAttributeValue("show", "not-a-boolean");
            part.Delete(); using var output = zip.CreateEntry("ppt/slides/slide1.xml").Open(); xml.Save(output);
        }
        var invalid = new PptxValidator().ValidateOpenXml(broken);
        Assert.Null(invalid.Failure);
        Assert.False(invalid.Valid);
        Assert.NotEmpty(invalid.Errors);
        var delta = new PptxValidator().Validate(source, broken, new HashSet<string> { "ppt/slides/slide1.xml" });
        Assert.False(delta.Valid);
        Assert.Contains(delta.Errors, error => error.Contains("Open XML validation"));
    }

    [Fact]
    public void UnicodeUriCollisionsAndMissingPartsDoNotBecomeValidationSuccess()
    {
        var source = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../../../eval/public/downloads/lo-transition-media.pptx"));
        foreach (var collision in new[] { true, false })
        {
            var broken = Path.Combine(directory, $"unicode-ambiguous-{collision}.pptx");
            File.Copy(source, broken);
            using (var zip = ZipFile.Open(broken, ZipArchiveMode.Update))
            {
                if (collision) zip.CreateEntry("ppt/media/Cort%C3%A1zar.wav");
                else zip.GetEntry("ppt/media/Cortázar.wav")!.Delete();
            }
            var invalid = new PptxValidator().ValidateOpenXml(broken);
            Assert.False(invalid.Valid);
            if (collision) Assert.NotNull(invalid.Failure);
            else { Assert.Null(invalid.Failure); Assert.NotEmpty(invalid.Errors); }
            Assert.False(new PptxValidator().Validate(source, broken,
                new HashSet<string> { "ppt/media/Cortázar.wav", "ppt/media/Cort%C3%A1zar.wav" }).Valid);
        }
    }

    private static byte[] Workbook(bool invalidMetadata)
    {
        using var bytes = new MemoryStream();
        using (var document = DocumentFormat.OpenXml.Packaging.SpreadsheetDocument.Create(bytes,
            DocumentFormat.OpenXml.SpreadsheetDocumentType.Workbook))
        {
            var book = document.AddWorkbookPart();
            var sheet = book.AddNewPart<DocumentFormat.OpenXml.Packaging.WorksheetPart>();
            sheet.Worksheet = new DocumentFormat.OpenXml.Spreadsheet.Worksheet(
                new DocumentFormat.OpenXml.Spreadsheet.SheetData());
            book.Workbook = new DocumentFormat.OpenXml.Spreadsheet.Workbook(
                new DocumentFormat.OpenXml.Spreadsheet.Sheets(new DocumentFormat.OpenXml.Spreadsheet.Sheet
                { Id = book.GetIdOfPart(sheet), SheetId = 1U, Name = "Data" }));
            document.AddExtendedFilePropertiesPart().Properties = new DocumentFormat.OpenXml.ExtendedProperties.Properties(
                new DocumentFormat.OpenXml.ExtendedProperties.Application("test"));
        }
        if (invalidMetadata)
        {
            bytes.Position = 0;
            using var zip = new ZipArchive(bytes, ZipArchiveMode.Update, leaveOpen: true);
            zip.GetEntry("docProps/app.xml")!.Delete();
            using var writer = new StreamWriter(zip.CreateEntry("docProps/app.xml").Open());
            writer.Write("<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><HeadingPairs><vt:vector size=\"0\" baseType=\"variant\"/></HeadingPairs></Properties>");
        }
        return bytes.ToArray();
    }

    private string EmbedWorkbook(byte[] workbook)
    {
        var file = Path.Combine(directory, Guid.NewGuid() + ".pptx");
        File.Copy(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../../../eval/public/fixtures/general-native-surface.pptx")), file);
        using var zip = ZipFile.Open(file, ZipArchiveMode.Update);
        using (var output = zip.CreateEntry("ppt/embeddings/test.xlsx").Open()) output.Write(workbook);
        var typeEntry = zip.GetEntry("[Content_Types].xml")!;
        XDocument types; using (var input = typeEntry.Open()) types = XDocument.Load(input);
        types.Root!.Add(new XElement(types.Root.Name.Namespace + "Override",
            new XAttribute("PartName", "/ppt/embeddings/test.xlsx"),
            new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")));
        typeEntry.Delete(); using (var output = zip.CreateEntry("[Content_Types].xml").Open()) types.Save(output);
        return file;
    }

    [Fact]
    public void PresentationValidationChecksEmbeddedWorkbookSchemaWithoutRewritingIt()
    {
        var valid = EmbedWorkbook(Workbook(false));
        var validReport = new PptxValidator().ValidateOpenXml(valid);
        Assert.True(validReport.Valid, validReport.Failure + ": " + string.Join("\n", validReport.Errors));
        var invalid = EmbedWorkbook(Workbook(true));
        var hash = Hashing.FileSha256(invalid);
        var report = new PptxValidator().ValidateOpenXml(invalid);
        Assert.False(report.Valid);
        Assert.Null(report.Failure);
        Assert.Contains(report.Errors, error => error.Contains("test.xlsx!") && error.Contains("HeadingPairs"));
        Assert.Equal(hash, Hashing.FileSha256(invalid));
    }

    [Fact]
    public void UnreadableEmbeddedWorkbookCannotBecomeSuccessOrHidePresentationErrors()
    {
        var file = EmbedWorkbook(System.Text.Encoding.UTF8.GetBytes("invalid workbook"));
        using (var zip = ZipFile.Open(file, ZipArchiveMode.Update))
        {
            var entry = zip.GetEntry("ppt/slides/slide1.xml")!;
            XDocument slide; using (var input = entry.Open()) slide = XDocument.Load(input);
            slide.Root!.SetAttributeValue("show", "invalid");
            entry.Delete(); using var output = zip.CreateEntry("ppt/slides/slide1.xml").Open(); slide.Save(output);
        }
        var report = new PptxValidator().ValidateOpenXml(file);
        Assert.False(report.Valid);
        Assert.NotNull(report.Failure);
        Assert.Contains(report.Errors, error => error.Contains("test.xlsx"));
        Assert.Contains(report.Errors, error => error.Contains("slide1.xml"));
        Assert.False(new PptxValidator().Validate(file, file, new HashSet<string>()).Valid);
    }

    [Fact]
    public void StructureCannotBeMixedWithStaleIndexedCommands()
    {
        var source = TestPresentationFactory.Create(directory);
        Assert.Throws<InvalidDataException>(() => Apply(source, new { op = "add_slide", templateSlideIndex = 0, insertIndex = 0 }, new { op = "replace_text", target = Target(source), text = "wrong" }));
    }
    [Fact]
    public void GroupingAndUngroupingPreserveChildGeometry()
    {
        var source = TestPresentationFactory.Create(directory);
        var two = Apply(source, new {op="duplicate_shape", target=Target(source), x=6000000L, y=914400L});
        var before = new PresentationInspector().Inspect(two).Slides[0].Elements;
        var grouped = Apply(two, new {op="group_shapes", targets=new[] {Target(two),Target(two,element:1)}});
        Assert.Single(new PresentationInspector().Inspect(grouped).Slides[0].Elements);
        var ungrouped = Apply(grouped, new {op="ungroup_shape",target=Target(grouped)});
        var after = new PresentationInspector().Inspect(ungrouped).Slides[0].Elements;
        Assert.Equal(before.Select(e=>(e.X,e.Y,e.Width,e.Height)), after.Select(e=>(e.X,e.Y,e.Width,e.Height)));
    }
    [Fact]
    public void ImageInsertionReplacementAndCropKeepOtherElementsIntact()
    {
        var source = TestPresentationFactory.Create(directory);
        var output = Path.Combine(directory,"image.pptx");
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=");
        var command = JsonSerializer.SerializeToElement(new {op="add_image",slideIndex=0,x=100L,y=100L,width=1000000L,height=1000000L,assetId="fixture"});
        var result = new PptxPatcher().Apply(source,output,new EditCommandBatch("1.0",Hashing.FileSha256(source),"image",[command]),new Dictionary<string,byte[]> {{"fixture",png}});
        Assert.True(result.Validation.Valid,string.Join("\n",result.Validation.Errors));
        Assert.Equal("picture",result.CandidateGraph.Slides[0].Elements[1].Kind);
        var cropped = Apply(output,new {op="crop_image",target=Target(output,element:1),left=0.1,top=0.1,right=0.1,bottom=0.1});
        Assert.Throws<InvalidDataException>(() => Apply(cropped,new {op="crop_image",target=Target(cropped,element:1),left=0.6,top=0.0,right=0.6,bottom=0.0}));
        var replacement = JsonSerializer.SerializeToElement(new {op="replace_image",target=Target(cropped,element:1),assetId="fixture"});
        var replaced = new PptxPatcher().Apply(cropped,Path.Combine(directory,"replaced.pptx"),new EditCommandBatch("1.0",Hashing.FileSha256(cropped),"replace",[replacement]),new Dictionary<string,byte[]> {{"fixture",png}});
        Assert.True(replaced.Validation.Valid,string.Join("\n",replaced.Validation.Errors));
        Assert.Equal(result.CandidateGraph.Slides[0].Elements[0].SourceHash,replaced.CandidateGraph.Slides[0].Elements[0].SourceHash);
    }
    [Fact]
    public void DistributionAndPlaceholderTextAreSupported()
    {
        var source = TestPresentationFactory.Create(directory);
        var three = Apply(source,new {op="duplicate_shape",target=Target(source),x=5000000L,y=914400L},new {op="duplicate_shape",target=Target(source),x=10000000L,y=914400L});
        var distributed = Apply(three,new {op="distribute_shapes",targets=new[] {Target(three),Target(three,element:1),Target(three,element:2)},axis="horizontal"});
        var elements = new PresentationInspector().Inspect(distributed).Slides[0].Elements.OrderBy(element => element.X).ToArray();
        Assert.InRange(Math.Abs((elements[1].X-elements[0].X)-(elements[2].X-elements[1].X)),0,1);
        using(var zip=ZipFile.Open(source,ZipArchiveMode.Update)) {
            var part=zip.GetEntry("ppt/slides/slide1.xml")!; XDocument xml; using(var input=part.Open()) xml=XDocument.Load(input);
            XNamespace p="http://schemas.openxmlformats.org/presentationml/2006/main";
            xml.Descendants(p+"sp").Single().Descendants(p+"nvPr").Single().Add(new XElement(p+"ph",new XAttribute("type","title")));
            part.Delete(); using(var output=zip.CreateEntry("ppt/slides/slide1.xml").Open()) xml.Save(output);
        }
        var edited=Apply(source,new {op="replace_text",target=Target(source),text="자리표시자 제목 수정"});
        Assert.Equal("자리표시자 제목 수정",new PresentationInspector().Inspect(edited).Slides[0].Elements[0].Text);
    }
    [Fact]
    public void PlaceholderGeometryComesFromLayoutAndIsMaterializedOnlyForGeometryEdits()
    {
        var source=TestPresentationFactory.Create(directory);
        using(var package=DocumentFormat.OpenXml.Packaging.PresentationDocument.Open(source,true))
        {
            var slide=package.PresentationPart!.SlideParts.Single();
            var shape=slide.Slide!.Descendants<DocumentFormat.OpenXml.Presentation.Shape>().Single();
            shape.NonVisualShapeProperties!.ApplicationNonVisualDrawingProperties!.Append(new DocumentFormat.OpenXml.Presentation.PlaceholderShape {Index=7U});
            shape.ShapeProperties!.Transform2D!.HorizontalFlip = true;
            var layout=slide.AddNewPart<DocumentFormat.OpenXml.Packaging.SlideLayoutPart>();
            layout.SlideLayout=new DocumentFormat.OpenXml.Presentation.SlideLayout((DocumentFormat.OpenXml.Presentation.CommonSlideData)slide.Slide.CommonSlideData!.CloneNode(true));
            layout.SlideLayout.Save();
            shape.ShapeProperties!.Transform2D!.Remove(); slide.Slide.Save();
        }
        var original=new PresentationInspector().Inspect(source).Slides[0].Elements[0];
        Assert.Equal(914400L,original.X); Assert.Equal(4572000L,original.Width);
        Assert.True(original.FlipHorizontal);
        var text=Apply(source,new {op="replace_text",target=Target(source),text="상속 유지"});
        XNamespace p="http://schemas.openxmlformats.org/presentationml/2006/main";
        Assert.DoesNotContain(XDocument.Parse(Read(text,"ppt/slides/slide1.xml")).Descendants(p+"spPr").Single().Elements(), element => element.Name.LocalName == "xfrm");
        var moved=Apply(text,new {op="move_shape",target=Target(text),x=1000000L,y=2000000L});
        var result=new PresentationInspector().Inspect(moved).Slides[0].Elements[0];
        Assert.Equal(1000000L,result.X); Assert.Equal(original.Width,result.Width);
        Assert.True(result.FlipHorizontal);
    }
    private static string Read(string path, string part)
    {
        using var zip = ZipFile.OpenRead(path); using var stream = zip.GetEntry(part)!.Open(); using var reader = new StreamReader(stream); return reader.ReadToEnd();
    }
    public void Dispose() => Directory.Delete(directory, true);
}
