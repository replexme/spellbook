using System.Text.Json;
using Spellbook.Document.Core;

// All previews belong to the new version, so deleting an older version cannot
// break the saved document. Reuse is optional; missing evidence renders in full.
public static class SavedPreviewRenderer
{
    public static async Task<(ElementGraph Graph, int RenderedSlideCount)> RenderAsync(
        LocalObjectStore storage,
        IDocumentFormatAdapter adapter,
        IPresentationRenderer renderer,
        string inputPath,
        string? baselinePath,
        string? baselineGraphObject,
        PackageChangeBudgetReport? validation,
        ElementGraph graph,
        string outputDirectory,
        string outputPrefix,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<int>? changedSlides = null;
        if (adapter.FormatId == "pptx" && baselinePath is not null &&
            validation is not null && !string.IsNullOrWhiteSpace(baselineGraphObject))
        {
            try
            {
                var baseline = JsonSerializer.Deserialize(
                    await storage.ReadAsync(baselineGraphObject, cancellationToken),
                    DocumentJsonContext.Default.ElementGraph);
                if (baseline is not null)
                {
                    changedSlides = PptxPreviewReusePlanner.ChangedSlideIndexes(
                        baselinePath, inputPath, baseline, graph, validation, renderer);
                    if (changedSlides is not null)
                    {
                        var changed = changedSlides.ToHashSet();
                        foreach (var slide in baseline.Slides.Where(slide => !changed.Contains(slide.SlideIndex)))
                            await storage.CopyAsync(slide.PreviewObject!,
                                $"{outputPrefix}/slides/slide-{slide.SlideIndex + 1}.png", cancellationToken);
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or JsonException or InvalidDataException)
            {
                // Corrupt/missing prior preview evidence must not reject a valid
                // save. Capacity and cancellation failures still fail the job.
                if (exception.Message == "storage_capacity_exhausted") throw;
                changedSlides = null;
            }
        }

        var images = changedSlides is null
            ? await adapter.RenderAsync(inputPath, outputDirectory, cancellationToken)
            : await renderer.RenderAsync(inputPath, outputDirectory, cancellationToken, changedSlides);
        var indexes = changedSlides ?? Enumerable.Range(0, graph.Slides.Count).ToArray();
        if (images.Count != indexes.Count ||
            !graph.Slides.Select(slide => slide.SlideIndex).SequenceEqual(Enumerable.Range(0, graph.Slides.Count)))
            throw new InvalidDataException("Rendered slide images do not match the document slide identities.");
        for (var index = 0; index < images.Count; index++)
        {
            if (!int.TryParse(Path.GetFileNameWithoutExtension(images[index]).Split('-').Last(), out var number) ||
                number != indexes[index] + 1)
                throw new InvalidDataException("Rendered slide image identity does not match the preview plan.");
            await storage.UploadFileAsync($"{outputPrefix}/slides/slide-{number}.png", images[index], cancellationToken);
        }
        return (graph with
        {
            RendererName = adapter.RendererName,
            RendererVersion = adapter.RendererVersion,
            Slides = graph.Slides.Select(slide => slide with
            {
                PreviewObject = $"{outputPrefix}/slides/slide-{slide.SlideIndex + 1}.png"
            }).ToList()
        }, images.Count);
    }
}
