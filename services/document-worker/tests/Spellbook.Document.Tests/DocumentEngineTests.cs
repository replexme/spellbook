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
    public void LibreOfficeRendererImplementsStableRendererBoundary()
    {
        IPresentationRenderer renderer = new LibreOfficeRenderer();

        Assert.Equal("LibreOffice", renderer.Name);
        Assert.False(string.IsNullOrWhiteSpace(renderer.Version));
    }

    [Fact]
    public void LibreOfficeRendererReportsTheConfiguredRelease()
    {
        var previous = Environment.GetEnvironmentVariable("SPELLBOOK_RENDERER_VERSION");
        try
        {
            Environment.SetEnvironmentVariable("SPELLBOOK_RENDERER_VERSION", "renderer-test-release");
            IPresentationRenderer renderer = new LibreOfficeRenderer();

            Assert.Equal("renderer-test-release", renderer.Version);
        }
        finally
        {
            Environment.SetEnvironmentVariable("SPELLBOOK_RENDERER_VERSION", previous);
        }
    }

    [Theory]
    [InlineData("Binary URP bridge already disposed")]
    [InlineData("Connector: couldn't connect to pipe uno123")]
    [InlineData("free(): invalid pointer")]
    [InlineData("Unspecified Application Error")]
    [InlineData("Segmentation fault")]
    public void LibreOfficeRendererRetriesOnlyKnownProcessTerminationFailures(string message)
    {
        Assert.True(LibreOfficeRenderer.IsRetryableLibreOfficeFailure(message));
        Assert.False(LibreOfficeRenderer.IsRetryableLibreOfficeFailure("The input is not a presentation document"));
    }

    [Theory]
    [InlineData("Binary URP bridge already disposed")]
    [InlineData("LibreOffice could not load /tmp/document.pptx")]
    public void LibreOfficeRendererFallsBackFromAnIsolatedNormalizationFailure(string message)
    {
        Assert.True(LibreOfficeRenderer.IsNormalizationFallbackFailure(message));
        Assert.False(LibreOfficeRenderer.IsNormalizationFallbackFailure("The input is not a presentation document"));
    }

    [Fact]
    public void LibreOfficeRendererIsolatesTheCompleteUserProfilePerProcess()
    {
        var processDirectory = Path.Combine(directory, "render process");
        var startInfo = new ProcessStartInfo();

        LibreOfficeRenderer.ConfigureProcessEnvironment(
            startInfo,
            processDirectory,
            new Dictionary<string, string> { ["FONTCONFIG_FILE"] = "/fonts.conf" });

        Assert.Equal(processDirectory, startInfo.Environment["HOME"]);
        Assert.Equal(
            Path.Combine(processDirectory, ".cache"),
            startInfo.Environment["XDG_CACHE_HOME"]);
        Assert.Equal(
            Path.Combine(processDirectory, ".config"),
            startInfo.Environment["XDG_CONFIG_HOME"]);
        Assert.Equal("/fonts.conf", startInfo.Environment["FONTCONFIG_FILE"]);
        Assert.True(Directory.Exists(startInfo.Environment["XDG_CACHE_HOME"]));
        Assert.True(Directory.Exists(startInfo.Environment["XDG_CONFIG_HOME"]));
    }

    [Fact]
    public void RasterSizeUsesTheSerializedSlideGeometryAtTheRendererResolution()
    {
        var path = TestPresentationFactory.Create(directory);

        var size = PptxRasterSize.Read(path, 144);

        Assert.Equal(new PptxRasterSize(1920, 1080), size);
    }

    [Fact]
    public void RasterSizeRejectsANonPositiveResolution()
    {
        var path = TestPresentationFactory.Create(directory);

        Assert.Throws<ArgumentOutOfRangeException>(() => PptxRasterSize.Read(path, 0));
    }

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
    public void RasterSizeRejectsAnUnboundedSlideBeforeStartingTheRenderer()
    {
        var path = TestPresentationFactory.Create(directory);
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Update))
        {
            var entry = archive.GetEntry("ppt/presentation.xml")!;
            XDocument xml;
            using (var stream = entry.Open()) xml = XDocument.Load(stream);
            var size = xml.Descendants().Single(element => element.Name.LocalName == "sldSz");
            size.SetAttributeValue("cx", 100_000_000);
            size.SetAttributeValue("cy", 100_000_000);
            entry.Delete();
            using var output = archive.CreateEntry("ppt/presentation.xml").Open();
            xml.Save(output);
        }
        Assert.Throws<InvalidDataException>(() => PptxRasterSize.Read(path, 144));
    }

    [Fact]
    public void LibreOfficeFontconfigAddsTheRenderScopedFontDirectory()
    {
        var fontDirectory = Path.Combine(directory, "embedded fonts & symbols");
        Directory.CreateDirectory(fontDirectory);

        var path = new LibreOfficeFontconfig("/fixture/system fonts.conf")
            .Create(directory, fontDirectory);
        var document = XDocument.Load(path);

        Assert.Equal("fontconfig", document.Root?.Name.LocalName);
        Assert.Equal(
            Path.GetFullPath("/fixture/system fonts.conf"),
            document.Root?.Element("include")?.Value);
        Assert.Equal(
            Path.GetFullPath(fontDirectory),
            document.Root?.Element("dir")?.Value);
        Assert.Equal("no", document.Root?.Element("include")?.Attribute("ignore_missing")?.Value);
    }

    [Fact]
    public void LibreOfficeFontconfigRejectsAMissingRenderScopedFontDirectory()
    {
        var missing = Path.Combine(directory, "missing-fonts");

        Assert.Throws<DirectoryNotFoundException>(() =>
            new LibreOfficeFontconfig("/fixture/fonts.conf").Create(directory, missing));
    }

    [Fact]
    public void RenderInputUsesTheEmbeddedFallbackForChartExWithoutChangingTheSource()
    {
        var source = Path.Combine(directory, "chartex-source.pptx");
        var output = Path.Combine(directory, "chartex-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                       xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
                       xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex">
                  <mc:AlternateContent>
                    <mc:Choice Requires="cx1">
                      <p:graphicFrame>
                        <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex" /></a:graphic>
                      </p:graphicFrame>
                    </mc:Choice>
                    <mc:Fallback><p:pic /></mc:Fallback>
                  </mc:AlternateContent>
                  <mc:AlternateContent>
                    <mc:Choice Requires="p14"><p:sp /></mc:Choice>
                    <mc:Fallback><p:sp /></mc:Fallback>
                  </mc:AlternateContent>
                </p:sld>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var sourceArchive = ZipFile.OpenRead(source);
        using var outputArchive = ZipFile.OpenRead(output);
        var sourceDocument = ReadXml(sourceArchive, "ppt/slides/slide1.xml");
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
        Assert.Equal("cx1", sourceDocument.Descendants(mc + "Choice").First().Attribute("Requires")?.Value);
        Assert.Equal(
            ["presentUnsupportedChartEx", "p14"],
            outputDocument.Descendants(mc + "Choice").Select(choice => choice.Attribute("Requires")?.Value ?? ""));
    }

    [Fact]
    public void RenderInputMaterializesKoreanDynamicDateInTheConfiguredTimeZone()
    {
        var source = Path.Combine(directory, "date-source.pptx");
        var output = Path.Combine(directory, "date-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:sp>
                    <p:txBody>
                      <a:p>
                        <a:fld id="{D26EE8B7-B740-44DA-B6CF-51F193288859}" type="datetime1">
                          <a:rPr lang="ko-KR" />
                          <a:t>2024-03-29</a:t>
                        </a:fld>
                      </a:p>
                    </p:txBody>
                  </p:sp>
                </p:sld>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);
        var utcNow = new DateTimeOffset(2026, 8, 28, 16, 0, 0, TimeSpan.Zero);

        new LibreOfficeRenderInput(
            () => utcNow,
            TimeZoneInfo.FindSystemTimeZoneById("Asia/Seoul"))
            .Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var outputArchive = ZipFile.OpenRead(output);
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        Assert.Empty(outputDocument.Descendants(drawing + "fld"));
        var runs = outputDocument.Descendants(drawing + "r").ToArray();
        Assert.Equal(
            "2026. 8. 29.",
            string.Concat(runs.Select(run => run.Element(drawing + "t")?.Value)));
        Assert.All(
            runs.Where(run => run.Element(drawing + "t")?.Value != " "),
            run => Assert.Equal(
                "ko-KR",
                run.Element(drawing + "rPr")?.Attribute("lang")?.Value));
        Assert.All(
            runs.Where(run => run.Element(drawing + "t")?.Value == " "),
            run => Assert.Equal(
                "en-US",
                run.Element(drawing + "rPr")?.Attribute("lang")?.Value));
    }

    [Fact]
    public void RenderInputFreezesSingleLineGeometryWithoutAuthorizingFontShrink()
    {
        var source = Path.Combine(directory, "numeric-autofit-source.pptx");
        var output = Path.Combine(directory, "numeric-autofit-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr wrap="square"><a:spAutoFit /></a:bodyPr>
                      <a:p><a:pPr algn="dist" /><a:r><a:t>1</a:t></a:r><a:r><a:t>39</a:t></a:r></a:p>
                    </p:txBody>
                  </p:sp>
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr wrap="none"><a:spAutoFit /></a:bodyPr>
                      <a:p><a:r><a:rPr lang="ko-KR" sz="5400" b="1" /><a:t>짧은 레이블</a:t></a:r></a:p>
                    </p:txBody>
                  </p:sp>
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr wrap="none"><a:spAutoFit /></a:bodyPr>
                      <a:p><a:r><a:t>첫 문단은 자동으로 더 나뉘지 않습니다</a:t></a:r></a:p>
                      <a:p><a:r><a:t>명시한 둘째 문단은 그대로 유지합니다</a:t></a:r></a:p>
                    </p:txBody>
                  </p:sp>
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr wrap="square"><a:spAutoFit /></a:bodyPr>
                      <a:p><a:r><a:t>자동 줄바꿈을 허용한 일반 문장입니다</a:t></a:r></a:p>
                    </p:txBody>
                  </p:sp>
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr wrap="square"><a:spAutoFit /></a:bodyPr>
                      <a:p><a:r><a:t>13</a:t></a:r><a:br /><a:r><a:t>9</a:t></a:r></a:p>
                    </p:txBody>
                  </p:sp>
                </p:sld>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var outputArchive = ZipFile.OpenRead(output);
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        var wraps = outputDocument
            .Descendants(drawing + "bodyPr")
            .Select(element => element.Attribute("wrap")?.Value ?? "")
            .ToArray();
        Assert.Equal(["none", "none", "none", "square", "square"], wraps);
        var bodyProperties = outputDocument.Descendants(drawing + "bodyPr").ToArray();
        Assert.Single(bodyProperties[0].Elements(drawing + "noAutofit"));
        Assert.Empty(outputDocument.Descendants(drawing + "normAutofit"));
        Assert.Null(bodyProperties[0].Element(drawing + "spAutoFit"));
        Assert.NotNull(bodyProperties[1].Element(drawing + "noAutofit"));
        Assert.NotNull(bodyProperties[2].Element(drawing + "noAutofit"));
        Assert.NotNull(bodyProperties[3].Element(drawing + "spAutoFit"));
        Assert.NotNull(bodyProperties[4].Element(drawing + "spAutoFit"));
        var characterProperties = Assert.Single(outputDocument.Descendants(drawing + "rPr"));
        Assert.Equal("5400", characterProperties.Attribute("sz")?.Value);
        Assert.Equal("1", characterProperties.Attribute("b")?.Value);
        Assert.Equal("ko-KR", characterProperties.Attribute("lang")?.Value);
        Assert.Equal(
            "ctr",
            outputDocument.Descendants(drawing + "pPr").First().Attribute("algn")?.Value);
    }

    [Fact]
    public void RenderInputPreservesAuthorDeclaredFontAutoFit()
    {
        var source = Path.Combine(directory, "declared-font-autofit-source.pptx");
        var output = Path.Combine(directory, "declared-font-autofit-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:sp><p:txBody>
                    <a:bodyPr wrap="none"><a:normAutofit fontScale="83000" lnSpcReduction="12000" /></a:bodyPr>
                    <a:p><a:r><a:rPr sz="5400" /><a:t>Explicit font fitting</a:t></a:r></a:p>
                  </p:txBody></p:sp>
                </p:sld>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var original = ZipFile.OpenRead(source);
        using var rendered = ZipFile.OpenRead(output);
        Assert.Equal(
            ReadXml(original, "ppt/slides/slide1.xml").ToString(),
            ReadXml(rendered, "ppt/slides/slide1.xml").ToString());
    }

    [Fact]
    public void RenderInputPreservesSpaceRunsAndLanguagesForEngineFontSelection()
    {
        var source = Path.Combine(directory, "east-asian-space-source.pptx");
        var output = Path.Combine(directory, "east-asian-space-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:sp>
                    <p:txBody>
                      <a:bodyPr />
                      <a:p>
                        <a:r><a:rPr lang="ko-KR" altLang="en-US" sz="2800" /><a:t>치료자는 내담자</a:t></a:r>
                        <a:r><a:rPr lang="ko-KR" altLang="en-US" sz="2800" /><a:t xml:space="preserve"> </a:t></a:r>
                        <a:r><a:rPr lang="en-US" /><a:t>plain text</a:t></a:r>
                      </a:p>
                    </p:txBody>
                  </p:sp>
                </p:sld>
                """);
            Write(archive, "ppt/slideLayouts/slideLayout1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr /><a:p>
                    <a:r><a:rPr lang="ko-KR" altLang="en-US" /><a:t>레이아웃 공백</a:t></a:r>
                  </a:p></p:txBody></p:sp></p:spTree></p:cSld>
                </p:sldLayout>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var outputArchive = ZipFile.OpenRead(output);
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        var runs = outputDocument.Descendants(drawing + "r").ToArray();
        Assert.Equal(["치료자는 내담자", " ", "plain text"], runs
            .Select(run => run.Element(drawing + "t")?.Value ?? string.Empty)
            .ToArray());
        Assert.Equal("ko-KR", runs[0].Element(drawing + "rPr")?.Attribute("lang")?.Value);
        Assert.Equal("ko-KR", runs[1].Element(drawing + "rPr")?.Attribute("lang")?.Value);
        Assert.Equal("en-US", runs[1].Element(drawing + "rPr")?.Attribute("altLang")?.Value);
        Assert.Equal("preserve", runs[1].Element(drawing + "t")?.Attribute(XNamespace.Xml + "space")?.Value);
        Assert.Equal("en-US", runs[2].Element(drawing + "rPr")?.Attribute("lang")?.Value);

        var layoutDocument = ReadXml(outputArchive, "ppt/slideLayouts/slideLayout1.xml");
        var layoutRuns = layoutDocument.Descendants(drawing + "r").ToArray();
        Assert.Equal(
            ["레이아웃 공백"],
            layoutRuns
                .Select(run => run.Element(drawing + "t")?.Value ?? string.Empty)
                .ToArray());
        Assert.Equal(
            "ko-KR",
            layoutRuns[0].Element(drawing + "rPr")?.Attribute("lang")?.Value);
    }

    [Fact]
    public void RenderInputSuppressesOnlyEmptyMediaAndTablePlaceholders()
    {
        var source = Path.Combine(directory, "empty-placeholders-source.pptx");
        var output = Path.Combine(directory, "empty-placeholders-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                  <p:cSld><p:spTree>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="media" idx="1" /></p:nvPr></p:nvSpPr><p:spPr /></p:sp>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="tbl" idx="2" /></p:nvPr></p:nvSpPr><p:spPr /><p:txBody><a:p /></p:txBody></p:sp>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="tbl" idx="3" /></p:nvPr></p:nvSpPr><p:spPr /><p:txBody><a:p><a:r><a:t>keep me</a:t></a:r></a:p></p:txBody></p:sp>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="media" idx="4" /></p:nvPr></p:nvSpPr><p:spPr><a:blipFill><a:blip r:embed="rId9" /></a:blipFill></p:spPr></p:sp>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="obj" idx="5" /></p:nvPr></p:nvSpPr><p:spPr /></p:sp>
                  </p:spTree></p:cSld>
                </p:sld>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var outputArchive = ZipFile.OpenRead(output);
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        var placeholders = outputDocument.Descendants(presentation + "ph")
            .Select(element => (
                Type: element.Attribute("type")?.Value,
                Index: element.Attribute("idx")?.Value))
            .ToArray();
        Assert.Equal(
            [("tbl", "3"), ("media", "4"), ("obj", "5")],
            placeholders);
    }

    [Fact]
    public void RenderInputMaterializesStaticCustomGeometryAsAnSvgPictureFallback()
    {
        var source = Path.Combine(directory, "picture-placeholder-source.pptx");
        var output = Path.Combine(directory, "picture-placeholder-render-copy.pptx");
        using (var archive = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Write(archive, "[Content_Types].xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
                  <Default Extension="xml" ContentType="application/xml" />
                </Types>
                """);
            Write(archive, "ppt/slides/slide1.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:cSld><p:spTree>
                    <p:sp><p:nvSpPr><p:cNvPr id="4" name="Picture Placeholder 3" /><p:nvPr><p:ph type="pic" idx="13" /></p:nvPr></p:nvSpPr><p:spPr /></p:sp>
                    <p:sp><p:nvSpPr><p:cNvPr id="5" name="Picture Placeholder 4" /><p:nvPr><p:ph type="pic" idx="14" /></p:nvPr></p:nvSpPr><p:spPr><a:prstGeom prst="ellipse" /></p:spPr></p:sp>
                  </p:spTree></p:cSld>
                </p:sld>
                """);
            Write(archive, "ppt/slides/_rels/slide1.xml.rels", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout7.xml" />
                </Relationships>
                """);
            Write(archive, "ppt/slideLayouts/slideLayout7.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <p:cSld><p:spTree>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="pic" idx="13" /></p:nvPr></p:nvSpPr>
                      <p:spPr><a:xfrm><a:off x="1200000" y="800000" /><a:ext cx="9000000" cy="5000000" /></a:xfrm><a:custGeom><a:pathLst><a:path w="9000000" h="5000000"><a:moveTo><a:pt x="1000000" y="1000000" /></a:moveTo><a:lnTo><a:pt x="5000000" y="1000000" /></a:lnTo><a:lnTo><a:pt x="5000000" y="4000000" /></a:lnTo><a:close /></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="FFD966" /></a:solidFill><a:ln><a:noFill /></a:ln></p:spPr>
                    </p:sp>
                    <p:sp><p:nvSpPr><p:nvPr><p:ph type="pic" idx="14" /></p:nvPr></p:nvSpPr><p:spPr><a:custGeom><a:pathLst /></a:custGeom></p:spPr></p:sp>
                  </p:spTree></p:cSld>
                </p:sldLayout>
                """);
        }
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var outputArchive = ZipFile.OpenRead(output);
        var outputDocument = ReadXml(outputArchive, "ppt/slides/slide1.xml");
        XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
        XNamespace presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
        XNamespace officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        var picture = Assert.Single(outputDocument.Descendants(presentation + "pic"));
        Assert.Equal(
            "1200000",
            picture.Element(presentation + "spPr")?.Element(drawing + "xfrm")?
                .Element(drawing + "off")?.Attribute("x")?.Value);
        var relationshipId = picture.Descendants(drawing + "blip").Single()
            .Attribute(officeRelationships + "embed")?.Value;
        Assert.Equal("rIdPresentPlaceholder1", relationshipId);
        var remainingShape = Assert.Single(outputDocument.Descendants(presentation + "sp"));
        Assert.Equal(
            "ellipse",
            remainingShape.Element(presentation + "spPr")?.Element(drawing + "prstGeom")?
                .Attribute("prst")?.Value);
        Assert.Equal(
            "14",
            Assert.Single(outputDocument.Descendants(presentation + "ph")).Attribute("idx")?.Value);

        var relationships = ReadXml(outputArchive, "ppt/slides/_rels/slide1.xml.rels");
        XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        var imageRelationship = relationships.Descendants(packageRelationships + "Relationship")
            .Single(element => element.Attribute("Id")?.Value == relationshipId);
        Assert.EndsWith(
            "/image",
            imageRelationship.Attribute("Type")?.Value,
            StringComparison.Ordinal);
        var svgEntry = Assert.Single(outputArchive.Entries, entry =>
            entry.FullName.StartsWith("ppt/media/spellbook-slide1-placeholder-", StringComparison.Ordinal)
            && entry.FullName.EndsWith(".svg", StringComparison.Ordinal));
        using var reader = new StreamReader(svgEntry.Open());
        var svg = reader.ReadToEnd();
        Assert.Contains("fill=\"#FFD966\"", svg, StringComparison.Ordinal);
        Assert.Contains("fill-rule=\"evenodd\"", svg, StringComparison.Ordinal);
        var contentTypes = ReadXml(outputArchive, "[Content_Types].xml");
        Assert.Contains(contentTypes.Descendants(), element =>
            element.Attribute("Extension")?.Value == "svg"
            && element.Attribute("ContentType")?.Value == "image/svg+xml");
        var layout = ReadXml(outputArchive, "ppt/slideLayouts/slideLayout7.xml");
        Assert.Equal(
            ["14"],
            layout.Descendants(presentation + "ph")
                .Select(element => element.Attribute("idx")?.Value ?? string.Empty)
                .ToArray());
    }

    [Fact]
    public void RenderInputNeutralizesExternalTargetsWithoutChangingTheSource()
    {
        var source = TestPresentationFactory.Create(directory);
        var output = Path.Combine(directory, "external-render-copy.pptx");
        AddExternalRelationship(
            source,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
            "https://media.example.com/linked-video.wmv");
        var sourceBytes = File.ReadAllBytes(source);

        new LibreOfficeRenderInput().Create(source, output);

        Assert.Equal(sourceBytes, File.ReadAllBytes(source));
        using var sourceArchive = ZipFile.OpenRead(source);
        using var outputArchive = ZipFile.OpenRead(output);
        var relationshipPath = "ppt/slides/_rels/slide1.xml.rels";
        XNamespace relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
        var sourceRelationship = Assert.Single(
            ReadXml(sourceArchive, relationshipPath).Descendants(relationships + "Relationship"));
        var outputRelationship = Assert.Single(
            ReadXml(outputArchive, relationshipPath).Descendants(relationships + "Relationship"));
        Assert.Equal("https://media.example.com/linked-video.wmv", sourceRelationship.Attribute("Target")?.Value);
        Assert.Equal(
            "file:///nonexistent/spellbook-blocked-external-relationship",
            outputRelationship.Attribute("Target")?.Value);
        Assert.Equal("External", outputRelationship.Attribute("TargetMode")?.Value);
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
    public void WorkerFailuresBecomeStableReasonCodes()
    {
        var compound = Path.Combine(directory, "protected.pptx");
        File.WriteAllBytes(compound, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
        var rejected = Assert.Throws<InvalidDataException>(() => WorkerFailure.RejectCompoundFile(compound));
        Assert.Equal("encrypted_or_legacy_file", WorkerFailure.Code(rejected));

        var broken = Path.Combine(directory, "broken.pptx");
        File.WriteAllBytes(broken, [0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
        var zip = Assert.ThrowsAny<InvalidDataException>(() => new PresentationInspector().Inspect(broken));
        Assert.Equal("invalid_package", WorkerFailure.Code(zip));

        Assert.Equal("broken_presentation", WorkerFailure.Code(new InvalidDataException("The package has no presentation part.")));
        Assert.Equal("render_failed", WorkerFailure.Code(new InvalidOperationException("LibreOffice did not create a PDF.")));
        Assert.Equal("storage_capacity_exhausted", WorkerFailure.Code(new InvalidDataException("storage_capacity_exhausted")));
        Assert.Equal("processing_failed", WorkerFailure.Code(new TimeoutException("slow")));
    }

    [Fact]
    public void PatcherPreservesAFileThatTheOpenXmlSdkCannotFullyLoad()
    {
        var path = TestPresentationFactory.Create(directory);
        AddInternalRelationship(
            path,
            "_rels/.rels",
            "rIdMissingThumbnail",
            "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail",
            "docProps/missing-thumbnail.jpeg");
        var graph = new PresentationInspector().Inspect(path);
        var element = Assert.Single(graph.Slides[0].Elements);
        var batch = ParseBatch($$"""
        {
          "contractVersion": "1.0",
          "baseDocumentSha256": "{{graph.DocumentSha256}}",
          "summary": "replace text while preserving a pre-existing package defect",
          "commands": [{
            "op": "replace_text",
            "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{element.SourceHash}}" },
            "text": "수정된 제목"
          }]
        }
        """);

        var result = new PptxPatcher().Apply(
            path,
            Path.Combine(directory, "candidate-with-missing-thumbnail.pptx"),
            batch);

        Assert.True(result.Validation.Valid, string.Join(Environment.NewLine, result.Validation.Errors));
        Assert.Equal(["ppt/slides/slide1.xml"], result.Validation.ChangedParts);
        Assert.Contains(
            result.Validation.Warnings,
            warning => warning.Contains("could not be fully checked", StringComparison.Ordinal));
        Assert.Equal("수정된 제목", Assert.Single(result.CandidateGraph.Slides[0].Elements).Text);
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
    public void PatchChangesOnlySlidePayloadAndPreservesEditability()
    {
        var source = TestPresentationFactory.Create(directory);
        var graph = new PresentationInspector().Inspect(source);
        var element = graph.Slides[0].Elements[0];
        var batch = ParseBatch($$"""
        {
          "contractVersion": "1.0",
          "baseDocumentSha256": "{{graph.DocumentSha256}}",
          "summary": "제목과 위치를 조정합니다.",
          "commands": [
            {
              "op": "replace_text",
              "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{element.SourceHash}}" },
              "text": "수정된 제목"
            },
            {
              "op": "move_shape",
              "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{element.SourceHash}}" },
              "x": 1200000,
              "y": 1300000
            },
            {
              "op": "set_fill",
              "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{element.SourceHash}}" },
              "rgb": "E7F0FF"
            }
          ]
        }
        """);
        var output = Path.Combine(directory, "candidate.pptx");

        var result = new PptxPatcher().Apply(source, output, batch);

        Assert.True(result.Validation.Valid, string.Join(Environment.NewLine, result.Validation.Errors));
        Assert.Equal(["ppt/slides/slide1.xml"], result.Validation.ChangedParts);
        var candidate = result.CandidateGraph.Slides[0].Elements[0];
        Assert.Equal("수정된 제목", candidate.Text);
        Assert.Equal(1200000L, candidate.X);
        Assert.Equal(1300000L, candidate.Y);
        Assert.True(candidate.Editable);
    }

    [Fact]
    public void PatchRejectsStaleElementHash()
    {
        var source = TestPresentationFactory.Create(directory);
        var graph = new PresentationInspector().Inspect(source);
        var element = graph.Slides[0].Elements[0];
        var batch = ParseBatch($$"""
        {
          "contractVersion": "1.0",
          "baseDocumentSha256": "{{graph.DocumentSha256}}",
          "summary": "stale",
          "commands": [{
            "op": "replace_text",
            "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{new string('0', 64)}}" },
            "text": "잘못된 수정"
          }]
        }
        """);

        var error = Assert.Throws<InvalidDataException>(() =>
            new PptxPatcher().Apply(source, Path.Combine(directory, "stale.pptx"), batch));
        Assert.Contains("changed since", error.Message);
    }

    [Fact]
    public void ValidatorRejectsSlideMetadataChangesEvenWhenTheSlidePartIsAllowed()
    {
        var source = TestPresentationFactory.Create(directory);
        var candidate = Path.Combine(directory, "unexpected-slide-change.pptx");
        File.Copy(source, candidate);
        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            var entry = archive.GetEntry("ppt/slides/slide1.xml")!;
            XDocument xml;
            using (var stream = entry.Open()) xml = XDocument.Load(stream);
            xml.Root!.SetAttributeValue("show", "0");
            entry.Delete();
            using var output = archive.CreateEntry("ppt/slides/slide1.xml").Open();
            xml.Save(output);
        }
        var shape = new PresentationInspector().Inspect(source).Slides[0].Elements[0];
        var report = new PptxValidator().Validate(source, candidate,
            new HashSet<string> { "ppt/slides/slide1.xml" },
            new Dictionary<string, IReadOnlySet<uint>> { ["ppt/slides/slide1.xml"] = new HashSet<uint> { shape.ShapeId } });
        Assert.False(report.Valid);
        Assert.Contains(report.Errors, error => error.Contains("Non-target slide content changed", StringComparison.Ordinal));
    }

    [Fact]
    public void PatchPreservesMixedRunFormattingAndParagraphsInTheActualPackage()
    {
        var source = TestPresentationFactory.Create(directory);
        using (var package = DocumentFormat.OpenXml.Packaging.PresentationDocument.Open(source, true))
        {
            var slide = package.PresentationPart!.SlideParts.Single().Slide!;
            var body = slide.Descendants<DocumentFormat.OpenXml.Presentation.TextBody>().Single();
            body.RemoveAllChildren<DocumentFormat.OpenXml.Drawing.Paragraph>();
            body.Append(new DocumentFormat.OpenXml.Drawing.Paragraph(
                new DocumentFormat.OpenXml.Drawing.Run(new DocumentFormat.OpenXml.Drawing.Text("앞 ")),
                new DocumentFormat.OpenXml.Drawing.Run(
                    new DocumentFormat.OpenXml.Drawing.RunProperties { Bold = true },
                    new DocumentFormat.OpenXml.Drawing.Text("강조")),
                new DocumentFormat.OpenXml.Drawing.Run(new DocumentFormat.OpenXml.Drawing.Text(" 뒤"))));
            body.Append(new DocumentFormat.OpenXml.Drawing.Paragraph(
                new DocumentFormat.OpenXml.Drawing.Run(new DocumentFormat.OpenXml.Drawing.Text("둘째 문단"))));
            slide.Save();
        }
        var originalBytes = File.ReadAllBytes(source);
        var graph = new PresentationInspector().Inspect(source);
        var element = graph.Slides[0].Elements[0];
        Assert.Equal("앞 강조 뒤\n둘째 문단", element.Text);
        var batch = ParseBatch($$"""
        {
          "contractVersion": "1.0",
          "baseDocumentSha256": "{{graph.DocumentSha256}}",
          "summary": "강조 문구만 수정",
          "commands": [{
            "op": "replace_text",
            "target": { "slideIndex": 0, "elementId": "{{element.ElementId}}", "sourceHash": "{{element.SourceHash}}" },
            "text": "앞 새강조 뒤\n둘째 문단"
          }]
        }
        """);
        var output = Path.Combine(directory, "mixed.pptx");
        var result = new PptxPatcher().Apply(source, output, batch);
        Assert.True(result.Validation.Valid, string.Join("\n", result.Validation.Errors));
        Assert.Equal(originalBytes, File.ReadAllBytes(source));
        Assert.Equal(new[] { "ppt/slides/slide1.xml" }, result.Validation.ChangedParts);
        Assert.Equal("앞 새강조 뒤\n둘째 문단", result.CandidateGraph.Slides[0].Elements[0].Text);
        using var zip = ZipFile.OpenRead(output);
        XNamespace a = "http://schemas.openxmlformats.org/drawingml/2006/main";
        var xml = ReadXml(zip, "ppt/slides/slide1.xml");
        Assert.Equal(2, xml.Descendants(a + "p").Count());
        var boldRun = xml.Descendants(a + "r").Single(x => x.Element(a + "rPr")?.Attribute("b")?.Value is "1" or "true");
        Assert.Equal("새강조", boldRun.Element(a + "t")?.Value);
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

    [Fact]
    public void UnsupportedFeaturePreserverRestoresUntouchedActiveXPackageClosure()
    {
        var baseline = TestPresentationFactory.Create(directory);
        AddActiveXFixture(baseline);
        var candidate = Path.Combine(directory, "activex-candidate.pptx");
        File.Copy(baseline, candidate);
        StripActiveXFixture(candidate);
        var output = Path.Combine(directory, "activex-preserved.pptx");

        var report = new PptxUnsupportedFeaturePreserver().Preserve(baseline, candidate, output);

        Assert.Equal([0], report.RestoredSlideIndexes);
        Assert.Equal(
            [
                "ppt/activeX/activeX1.bin",
                "ppt/activeX/activeX1.xml",
                "ppt/drawings/vmlDrawing1.vml",
                "ppt/media/control1.wmf"
            ],
            report.CopiedParts);
        using (var archive = ZipFile.OpenRead(output))
        {
            var slide = ReadXml(archive, "ppt/slides/slide1.xml");
            Assert.Single(slide.Descendants(), element => element.Name.LocalName == "controls");
            Assert.NotNull(archive.GetEntry("ppt/activeX/activeX1.bin"));
            Assert.NotNull(archive.GetEntry("ppt/drawings/vmlDrawing1.vml"));
            Assert.NotNull(archive.GetEntry("ppt/media/control1.wmf"));
            var relationships = ReadXml(archive, "ppt/slides/_rels/slide1.xml.rels");
            Assert.Contains(
                relationships.Descendants(),
                element => ((string?)element.Attribute("Type"))?.EndsWith("/control", StringComparison.Ordinal) == true);
        }
        var scan = new PptxSafetyScanner().Scan(output);
        Assert.Contains(scan.Warnings, warning => warning.Contains("ActiveX", StringComparison.Ordinal));
        var graph = new PresentationInspector(new RendererFontEnvironment(true, ["Fixture Sans"]))
            .Inspect(output, scan);
        Assert.Equal("B", Assert.Single(graph.Slides).SupportGrade);
        Assert.Contains(graph.Slides[0].Warnings, warning => warning.Contains("ActiveX", StringComparison.Ordinal));
    }

    [Fact]
    public void UnsupportedFeaturePreserverRestoresPresentationFeaturesDroppedByLibreOffice()
    {
        var baseline = TestPresentationFactory.Create(directory);
        AddUnsupportedPresentationFeatureFixture(baseline);
        var candidate = Path.Combine(directory, "presentation-features-candidate.pptx");
        File.Copy(baseline, candidate);
        StripUnsupportedPresentationFeatureFixture(candidate);
        var output = Path.Combine(directory, "presentation-features-preserved.pptx");

        var report = new PptxUnsupportedFeaturePreserver().Preserve(baseline, candidate, output);

        Assert.Equal(
            ["ppt/printerSettings/printerSettings1.bin", "ppt/tableStyles.xml"],
            report.CopiedParts);
        using (var archive = ZipFile.OpenRead(output))
        {
            Assert.NotNull(archive.GetEntry("ppt/printerSettings/printerSettings1.bin"));
            Assert.NotNull(archive.GetEntry("ppt/tableStyles.xml"));
            var relationships = ReadXml(archive, "ppt/_rels/presentation.xml.rels");
            Assert.Contains(
                relationships.Descendants(),
                element => ((string?)element.Attribute("Type"))?.EndsWith("/printerSettings", StringComparison.Ordinal) == true);
            Assert.Contains(
                relationships.Descendants(),
                element => ((string?)element.Attribute("Type"))?.EndsWith("/tableStyles", StringComparison.Ordinal) == true);
        }

        var validation = new PptxPackageChangeBudgetValidator().Validate(
            baseline,
            output,
            new PackageChangeBudgetRequest(
                ContractVersions.Current,
                ["package_manifest", "presentation_relationships"]));
        Assert.True(validation.Valid, string.Join("\n", validation.Errors));
        Assert.DoesNotContain(validation.Changes, change => change.Category == "unknown");
    }

    [Fact]
    public void UnsupportedFeaturePreserverRejectsChangedPresentationFeatureContent()
    {
        var baseline = TestPresentationFactory.Create(directory);
        AddUnsupportedPresentationFeatureFixture(baseline);
        var candidate = Path.Combine(directory, "changed-table-styles.pptx");
        File.Copy(baseline, candidate);
        using (var archive = ZipFile.Open(candidate, ZipArchiveMode.Update))
        {
            archive.GetEntry("ppt/tableStyles.xml")!.Delete();
            Write(
                archive,
                "ppt/tableStyles.xml",
                "<a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"changed\" />");
        }

        var error = Assert.Throws<InvalidDataException>(() =>
            new PptxUnsupportedFeaturePreserver().Preserve(
                baseline,
                candidate,
                Path.Combine(directory, "changed-table-styles-output.pptx")));
        Assert.Contains("collides with candidate content", error.Message, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        Directory.Delete(directory, true);
        GC.SuppressFinalize(this);
    }

    private static EditCommandBatch ParseBatch(string json) =>
        JsonSerializer.Deserialize(json, DocumentJsonContext.Default.EditCommandBatch) ??
        throw new InvalidDataException("Unable to parse edit batch.");

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
}
