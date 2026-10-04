using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Xml.Linq;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

[CollectionDefinition(nameof(RenderEnvironmentCollection), DisableParallelization = true)]
public sealed class RenderEnvironmentCollection;

// These tests replace process-wide renderer variables (SOFFICE_PATH and
// friends), so they never run alongside another test.
[Collection(nameof(RenderEnvironmentCollection))]
public sealed class RenderSafetyTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), $"spellbook-render-tests-{Guid.NewGuid():N}");

    public RenderSafetyTests() => Directory.CreateDirectory(directory);

    [Fact]
    public async Task RenderTimeoutStopsTheWholeProcessTreeAndReportsRenderTimeout()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux() || OperatingSystem.IsMacOS(), "Needs a POSIX shell.");
        var path = TestPresentationFactory.Create(directory);
        var parentPidPath = Path.Combine(directory, "parent.pid");
        var childPidPath = Path.Combine(directory, "child.pid");
        var soffice = FakeSoffice(
            $"echo $$ > '{parentPidPath}'\nsleep 30 &\necho $! > '{childPidPath}'\nwait\n");
        var renderer = new LibreOfficeRenderer(TimeSpan.FromSeconds(1.5));

        var elapsed = Stopwatch.StartNew();
        var exception = await WithRendererEnvironment(soffice, () =>
            Assert.ThrowsAsync<RenderTimeoutException>(() => renderer.RenderAsync(
                path, Path.Combine(directory, "slides"), TestContext.Current.CancellationToken)));
        elapsed.Stop();

        Assert.Equal("render_timeout", WorkerFailure.Code(exception));
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(10), $"Render took {elapsed.Elapsed}.");
        Assert.False(await IsRunningAfterGrace(int.Parse(File.ReadAllText(parentPidPath).Trim())));
        Assert.False(await IsRunningAfterGrace(int.Parse(File.ReadAllText(childPidPath).Trim())));
    }

    [Fact]
    public async Task CallerCancellationStaysCancellationAndIsNotReportedAsTimeout()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux() || OperatingSystem.IsMacOS(), "Needs a POSIX shell.");
        var path = TestPresentationFactory.Create(directory);
        var pidPath = Path.Combine(directory, "soffice.pid");
        var soffice = FakeSoffice($"echo $$ > '{pidPath}'\nexec sleep 30\n");
        var renderer = new LibreOfficeRenderer(TimeSpan.FromSeconds(60));
        using var request = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        request.CancelAfter(TimeSpan.FromSeconds(1));

        var exception = await WithRendererEnvironment(soffice, () =>
            Assert.ThrowsAnyAsync<OperationCanceledException>(() => renderer.RenderAsync(
                path, Path.Combine(directory, "slides"), request.Token)));

        Assert.IsNotType<RenderTimeoutException>(exception);
        Assert.False(await IsRunningAfterGrace(int.Parse(File.ReadAllText(pidPath).Trim())));
    }

    [Theory]
    [InlineData(null, 300)]
    [InlineData("", 300)]
    [InlineData("45", 45)]
    [InlineData("10", 10)]
    [InlineData("840", 840)]
    [InlineData("9", 300)]
    [InlineData("841", 300)]
    [InlineData("-60", 300)]
    [InlineData("1.5", 300)]
    [InlineData("soon", 300)]
    public void RenderTimeoutConfigurationFallsBackToTheDefault(string? value, int expectedSeconds)
    {
        Assert.Equal(TimeSpan.FromSeconds(expectedSeconds), LibreOfficeRenderer.RenderTimeoutFrom(value));
    }

    [Fact]
    public void PixelBudgetAcceptsOrdinaryImagesAndUnknownMedia()
    {
        var path = TestPresentationFactory.Create(directory);
        AddMedia(path, "ppt/media/image1.png", Png(1920, 1080));
        AddMedia(path, "ppt/media/image2.jpeg", Jpeg(4000, 3000));
        AddMedia(path, "ppt/media/image3.gif", Gif(640, 480));
        AddMedia(path, "ppt/media/image4.bmp", Bmp(800, -600));
        AddMedia(path, "ppt/media/image5.emf", [0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]);

        new PptxImagePixelBudget().Check(path);
    }

    [Theory]
    [InlineData("png")]
    [InlineData("jpeg")]
    [InlineData("gif")]
    [InlineData("bmp")]
    public void PixelBudgetRejectsASingleImageAboveTheLimitFromItsHeader(string format)
    {
        var path = TestPresentationFactory.Create(directory);
        // The declared size is what a decoder would allocate; no pixel data exists.
        byte[] image = format switch
        {
            "png" => Png(20_000, 20_000),
            "jpeg" => Jpeg(30_000, 30_000),
            "gif" => Gif(65_535, 65_535),
            _ => Bmp(50_000, 50_000)
        };
        AddMedia(path, $"ppt/media/image1.{format}", image);

        var exception = Assert.Throws<InvalidDataException>(() => new PptxImagePixelBudget().Check(path));

        Assert.Equal("image_too_large", WorkerFailure.Code(exception));
    }

    [Fact]
    public void PixelBudgetRejectsTheSumOfImagesAboveTheTotalLimit()
    {
        var path = TestPresentationFactory.Create(directory);
        for (var index = 1; index <= 5; index++)
            AddMedia(path, $"ppt/media/image{index}.png", Png(10_000, 9_000));

        var exception = Assert.Throws<InvalidDataException>(() => new PptxImagePixelBudget().Check(path));

        Assert.Equal("image_too_large", WorkerFailure.Code(exception));
        new PptxImagePixelBudget(maxTotalImagePixels: 500_000_000).Check(path);
    }

    [Fact]
    public void PixelBudgetFindsTheJpegFrameHeaderAfterLargeMetadataSegments()
    {
        var path = TestPresentationFactory.Create(directory);
        AddMedia(path, "ppt/media/image1.jpg", Jpeg(30_000, 30_000, metadataSegments: 8));

        Assert.Throws<InvalidDataException>(() => new PptxImagePixelBudget().Check(path));
    }

    [Fact]
    public async Task RendererAppliesThePixelBudgetBeforeStartingAnyProcess()
    {
        var path = TestPresentationFactory.Create(directory);
        AddMedia(path, "ppt/media/image1.png", Png(20_000, 20_000));
        var missing = Path.Combine(directory, "missing-soffice");

        var exception = await WithRendererEnvironment(missing, () =>
            Assert.ThrowsAsync<InvalidDataException>(() => new LibreOfficeRenderer(TimeSpan.FromSeconds(30))
                .RenderAsync(path, Path.Combine(directory, "slides"), TestContext.Current.CancellationToken)));

        Assert.Equal("image_too_large", WorkerFailure.Code(exception));
    }

    [Fact]
    public void ScannerLimitViolationsBecomeReasonCodes()
    {
        var empty = Path.Combine(directory, "empty.pptx");
        File.WriteAllBytes(empty, []);
        Assert.Equal("invalid_package", ScanFailure(empty));

        var large = Path.Combine(directory, "large.pptx");
        using (var stream = File.Create(large))
            stream.SetLength(PptxSafetyScanner.DefaultMaxCompressedBytes + 1);
        Assert.Equal("file_too_large", ScanFailure(large));

        var slides = TestPresentationFactory.Create(directory);
        using (var archive = ZipFile.Open(slides, ZipArchiveMode.Update))
            for (var index = 2; index <= PptxSafetyScanner.DefaultMaxSlides + 1; index++)
                using (var output = archive.CreateEntry($"ppt/slides/slide{index}.xml").Open())
                    output.Write("<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>"u8);
        Assert.Equal("too_many_slides", ScanFailure(slides));

        var ratioDirectory = Directory.CreateDirectory(Path.Combine(directory, "ratio")).FullName;
        var ratio = TestPresentationFactory.Create(ratioDirectory);
        using (var archive = ZipFile.Open(ratio, ZipArchiveMode.Update))
        using (var output = archive.CreateEntry("ppt/media/zeros.bin", CompressionLevel.SmallestSize).Open())
            output.Write(new byte[8 * 1024 * 1024]);
        Assert.Equal("expanded_too_large", ScanFailure(ratio));
    }

    [Fact]
    public void ReasonCodesCoverTimeoutAndCanvasLimits()
    {
        Assert.Equal("render_timeout", WorkerFailure.Code(new RenderTimeoutException(TimeSpan.FromSeconds(300))));
        Assert.Equal("processing_failed", WorkerFailure.Code(new TimeoutException("slow")));

        var path = TestPresentationFactory.Create(directory);
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Update))
        {
            var entry = archive.GetEntry("ppt/presentation.xml")!;
            XDocument xml;
            using (var stream = entry.Open()) xml = XDocument.Load(stream);
            // PowerPoint's largest slide (56 in square) exceeds the raster canvas limit.
            var size = xml.Descendants().Single(element => element.Name.LocalName == "sldSz");
            size.SetAttributeValue("cx", 51_206_400);
            size.SetAttributeValue("cy", 51_206_400);
            entry.Delete();
            using var output = archive.CreateEntry("ppt/presentation.xml").Open();
            xml.Save(output);
        }
        var exception = Assert.Throws<InvalidDataException>(() => PptxRasterSize.Read(path, 144));
        Assert.Equal("image_too_large", WorkerFailure.Code(exception));
    }

    public void Dispose()
    {
        Directory.Delete(directory, true);
        GC.SuppressFinalize(this);
    }

    private static string ScanFailure(string path) =>
        WorkerFailure.Code(Assert.Throws<InvalidDataException>(() => new PptxSafetyScanner().Scan(path)));

    private string FakeSoffice(string body)
    {
        var path = Path.Combine(directory, "fake-soffice.sh");
        File.WriteAllText(path, "#!/bin/sh\n" + body);
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return path;
    }

    private static async Task<T> WithRendererEnvironment<T>(string soffice, Func<Task<T>> action)
    {
        string[] names = ["SOFFICE_PATH", "SPELLBOOK_DISABLE_CJK_SCRIPT_SPACING"];
        var previous = names.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable("SOFFICE_PATH", soffice);
            // Unset: the renderer takes the plain soffice --convert-to path.
            Environment.SetEnvironmentVariable("SPELLBOOK_DISABLE_CJK_SCRIPT_SPACING", null);
            return await action();
        }
        finally
        {
            foreach (var (name, value) in previous)
                Environment.SetEnvironmentVariable(name, value);
        }
    }

    private static async Task<bool> IsRunningAfterGrace(int pid)
    {
        // A killed orphan is reaped by init shortly after it dies.
        for (var attempt = 0; attempt < 50; attempt++)
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                if (process.HasExited) return false;
            }
            catch (ArgumentException)
            {
                return false;
            }
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
        return true;
    }

    private static void AddMedia(string pptxPath, string entryName, byte[] data)
    {
        using var archive = ZipFile.Open(pptxPath, ZipArchiveMode.Update);
        using var output = archive.CreateEntry(entryName).Open();
        output.Write(data);
    }

    private static byte[] Png(uint width, uint height)
    {
        var data = new byte[33];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(data, 0);
        BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(8), 13);
        "IHDR"u8.CopyTo(data.AsSpan(12));
        BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(16), width);
        BinaryPrimitives.WriteUInt32BigEndian(data.AsSpan(20), height);
        data[24] = 8;
        data[25] = 6;
        return data;
    }

    private static byte[] Jpeg(ushort width, ushort height, int metadataSegments = 1)
    {
        var data = new List<byte> { 0xFF, 0xD8 };
        for (var index = 0; index < metadataSegments; index++)
        {
            // A full-size APP1 segment (EXIF/XMP sized) before the frame header.
            data.AddRange([0xFF, 0xE1, 0xFF, 0xFF]);
            data.AddRange(new byte[0xFFFF - 2]);
        }
        data.AddRange([0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00]);
        data.AddRange([0xFF, 0xC2, 0x00, 0x11, 0x08,
            (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width,
            0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        data.AddRange([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        return [.. data];
    }

    private static byte[] Gif(ushort width, ushort height)
    {
        var data = new byte[13];
        "GIF89a"u8.CopyTo(data);
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(6), width);
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(8), height);
        return data;
    }

    private static byte[] Bmp(int width, int height)
    {
        var data = new byte[54];
        data[0] = (byte)'B';
        data[1] = (byte)'M';
        BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(14), 40);
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(18), width);
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(22), height);
        return data;
    }
}
