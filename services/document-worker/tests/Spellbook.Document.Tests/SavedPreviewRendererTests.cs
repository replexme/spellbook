using System.IO.Compression;
using System.Text.Json;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class SavedPreviewRendererTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), $"spellbook-saved-preview-{Guid.NewGuid():N}");

    public SavedPreviewRendererTests() => Directory.CreateDirectory(directory);

    [Theory]
    [InlineData("selective", 1)]
    [InlineData("unchanged", 0)]
    [InlineData("missing-graph", 50)]
    [InlineData("corrupt-graph", 50)]
    [InlineData("missing-preview", 50)]
    [InlineData("changed-master", 50)]
    [InlineData("wrong-hash", 50)]
    [InlineData("wrong-renderer", 50)]
    public async Task SavesEveryPreviewWithCorrectIdentityAndSafeFallback(string scenario, int expectedRendered)
    {
        var token = TestContext.Current.CancellationToken;
        var storage = new LocalObjectStore(Path.Combine(directory, "store"), LocalObjectStore.MinimumReserveBytes, _ => long.MaxValue);
        var renderer = new RecordingRenderer();
        var adapter = new PptxDocumentFormatAdapter(new PptxSafetyScanner(), new PresentationInspector(), new PptxPatcher(), renderer);
        var baselinePath = Path.Combine(directory, "baseline.pptx");
        var candidatePath = Path.Combine(directory, "candidate.pptx");
        WritePackage(baselinePath, false, false);
        WritePackage(candidatePath, scenario != "unchanged", scenario == "changed-master");
        var baseline = Graph(baselinePath, renderer);
        var candidate = Graph(candidatePath, renderer);
        if (scenario == "wrong-hash") baseline = baseline with { DocumentSha256 = "wrong" };
        if (scenario == "wrong-renderer") baseline = baseline with { RendererVersion = "old" };
        var report = new PackageChangeBudgetReport(ContractVersions.Current, true,
            Hashing.FileSha256(baselinePath), candidate.DocumentSha256, [], []);
        if (scenario != "missing-graph")
            await storage.UploadJsonAsync("prior/element-graph.json", baseline, DocumentJsonContext.Default.ElementGraph, token);
        if (scenario == "corrupt-graph")
        {
            var invalid = Path.Combine(directory, "invalid.json");
            await File.WriteAllTextAsync(invalid, "{invalid", token);
            await storage.UploadFileAsync("prior/element-graph.json", invalid, token);
        }
        var preview = Path.Combine(directory, "prior.png");
        foreach (var slide in baseline.Slides)
        {
            if (scenario == "missing-preview" && slide.SlideIndex == 49) continue;
            await File.WriteAllTextAsync(preview, $"prior-{slide.SlideIndex}", token);
            await storage.UploadFileAsync(slide.PreviewObject!, preview, token);
        }
        var result = await SavedPreviewRenderer.RenderAsync(storage, adapter, renderer,
            candidatePath, baselinePath, "prior/element-graph.json", report, candidate,
            Path.Combine(directory, "render"), "saved", token);
        Assert.Equal(expectedRendered, result.RenderedSlideCount);
        Assert.Equal(50, result.Graph.Slides.Count);
        Assert.Equal(expectedRendered, renderer.RenderedIndexes.Count);
        // Remove the older version: the new version must own all 50 previews.
        Directory.Delete(Path.Combine(directory, "store", "prior"), true);
        foreach (var slide in result.Graph.Slides)
        {
            Assert.Equal($"saved/slides/slide-{slide.SlideIndex + 1}.png", slide.PreviewObject);
            var content = System.Text.Encoding.UTF8.GetString(await storage.ReadAsync(slide.PreviewObject!, token));
            var newlyRendered = expectedRendered == 50 || expectedRendered == 1 && slide.SlideIndex == 37;
            Assert.Equal($"{(newlyRendered ? "rendered" : "prior")}-{slide.SlideIndex}", content);
        }
    }

    [Fact]
    public async Task RejectsMisnumberedSelectedRender()
    {
        var renderer = new RecordingRenderer { WrongNumber = true };
        var adapter = new PptxDocumentFormatAdapter(new PptxSafetyScanner(), new PresentationInspector(), new PptxPatcher(), renderer);
        var path = Path.Combine(directory, "baseline.pptx");
        WritePackage(path, false, false);
        var storage = new LocalObjectStore(Path.Combine(directory, "store"), LocalObjectStore.MinimumReserveBytes, _ => long.MaxValue);
        await Assert.ThrowsAsync<InvalidDataException>(() => SavedPreviewRenderer.RenderAsync(
            storage, adapter, renderer, path, null, null, null, Graph(path, renderer),
            Path.Combine(directory, "render"), "saved", TestContext.Current.CancellationToken));
    }

    private static void WritePackage(string path, bool changedSlide, bool changedMaster)
    {
        using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
        for (var index = 0; index < 50; index++)
        {
            using var writer = new StreamWriter(zip.CreateEntry($"ppt/slides/slide{index + 1}.xml").Open());
            writer.Write(index == 37 && changedSlide ? "changed" : "same");
        }
        using var master = new StreamWriter(zip.CreateEntry("ppt/slideMasters/slideMaster1.xml").Open());
        master.Write(changedMaster ? "changed" : "same");
    }

    private static ElementGraph Graph(string path, IPresentationRenderer renderer) => new(
        ContractVersions.Current, Hashing.FileSha256(path), 100, 100, true, [], [], [],
        Enumerable.Range(0, 50).Select(index => new SlideGraph(index,
            $"/ppt/slides/slide{index + 1}.xml", $"prior/slides/slide-{index + 1}.png", "A", [], [])).ToList(),
        [], renderer.Name, renderer.Version);

    private sealed class RecordingRenderer : IPresentationRenderer
    {
        public string Name => "fixture";
        public string Version => "1";
        public bool WrongNumber { get; init; }
        public List<int> RenderedIndexes { get; } = [];
        public async Task<IReadOnlyList<string>> RenderAsync(string input, string output, CancellationToken token, IReadOnlyList<int>? slideIndexes = null)
        {
            Directory.CreateDirectory(output);
            var paths = new List<string>();
            foreach (var index in slideIndexes ?? Enumerable.Range(0, 50).ToArray())
            {
                RenderedIndexes.Add(index);
                var path = Path.Combine(output, $"slide-{(WrongNumber ? index + 2 : index + 1)}.png");
                await File.WriteAllTextAsync(path, $"rendered-{index}", token);
                paths.Add(path);
            }
            return paths;
        }
    }

    public void Dispose() => Directory.Delete(directory, true);
}
