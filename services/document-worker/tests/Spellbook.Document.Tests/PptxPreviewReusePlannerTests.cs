using System.IO.Compression;
using System.Security.Cryptography;
using Spellbook.Document.Core;
using Xunit;

namespace Spellbook.Document.Tests;

public sealed class PptxPreviewReusePlannerTests
{
    [Fact]
    public void ReusesOnlyUnchangedSlidePreviews()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"spellbook-preview-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var baselinePath = Path.Combine(directory, "baseline.pptx");
            var candidatePath = Path.Combine(directory, "candidate.pptx");
            WritePackage(baselinePath, "before", "master");
            WritePackage(candidatePath, "after", "master", reformattedManifest: true);
            var renderer = new LibreOfficeRenderer();
            var baseline = Graph(baselinePath, renderer);
            var candidate = Graph(candidatePath, renderer);
            var validation = Report(baseline, candidate);

            Assert.Equal([0], PptxPreviewReusePlanner.ChangedSlideIndexes(
                baselinePath, candidatePath, baseline, candidate, validation, renderer));

            WritePackage(candidatePath, "before", "master", reformattedManifest: true);
            candidate = Graph(candidatePath, renderer);
            Assert.Empty(PptxPreviewReusePlanner.ChangedSlideIndexes(
                baselinePath, candidatePath, baseline, candidate,
                Report(baseline, candidate), renderer)!);

            WritePackage(candidatePath, "after", "master", changedManifest: true);
            candidate = Graph(candidatePath, renderer);
            Assert.Null(PptxPreviewReusePlanner.ChangedSlideIndexes(
                baselinePath, candidatePath, baseline, candidate,
                Report(baseline, candidate), renderer));

            WritePackage(candidatePath, "after", "different master");
            candidate = Graph(candidatePath, renderer);
            Assert.Null(PptxPreviewReusePlanner.ChangedSlideIndexes(
                baselinePath, candidatePath, baseline, candidate,
                Report(baseline, candidate), renderer));
            Assert.Null(PptxPreviewReusePlanner.ChangedSlideIndexes(
                baselinePath, candidatePath, baseline,
                candidate with { Slides = candidate.Slides.Reverse().ToList() },
                Report(baseline, candidate), renderer));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    private static void WritePackage(
        string path, string firstSlide, string master,
        bool reformattedManifest = false, bool changedManifest = false)
    {
        if (File.Exists(path)) File.Delete(path);
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        foreach (var (name, text) in new Dictionary<string, string>
        {
            ["ppt/slides/slide1.xml"] = firstSlide,
            ["ppt/slides/slide2.xml"] = "unchanged",
            ["ppt/slideMasters/slideMaster1.xml"] = master,
            ["[Content_Types].xml"] = reformattedManifest
                ? "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default ContentType=\"text/xml\" Extension=\"xml\" /></Types>"
                : $"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"{(changedManifest ? "application/changed" : "text/xml")}\"/></Types>",
            ["docProps/core.xml"] = Guid.NewGuid().ToString()
        })
        {
            using var writer = new StreamWriter(archive.CreateEntry(name).Open());
            writer.Write(text);
        }
    }

    private static ElementGraph Graph(string path, IPresentationRenderer renderer) => new(
        ContractVersions.Current,
        Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))),
        100, 100, true, [], [], [],
        Enumerable.Range(0, 2).Select(index => new SlideGraph(
            index, $"/ppt/slides/slide{index + 1}.xml",
            $"prior/slides/slide-{index + 1}.png", "A", [], [])).ToList(),
        [], renderer.Name, renderer.Version);

    private static PackageChangeBudgetReport Report(ElementGraph baseline, ElementGraph candidate) => new(
        ContractVersions.Current, true, baseline.DocumentSha256,
        candidate.DocumentSha256, [], []);
}
