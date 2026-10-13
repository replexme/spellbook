using System.Text.Json;
using Spellbook.Document.Core;

if (args.Length < 1)
{
    Usage();
    return 2;
}

switch (args[0])
{
    case "inspect" when args.Length == 3:
    {
        var scanner = new PptxSafetyScanner();
        var scan = scanner.Scan(args[1]);
        // The font check comes from the engine when its program is present (the worker image).
        var graph = PptxDocumentFormatAdapter.ConfiguredEngine() is { } engine
            ? new PptxDocumentFormatAdapter(scanner, new EngineProgram(engine, "pptx")).Inspect(args[1], scan)
            : new PresentationInspector().Inspect(args[1], scan);
        await WriteJson(args[2], graph, DocumentJsonContext.Default.ElementGraph);
        break;
    }
    case "extract-embedded-fonts" when args.Length == 3:
    {
        var paths = new PptxEmbeddedFontExtractor().ExtractToDirectory(args[1], args[2]);
        foreach (var path in paths) Console.WriteLine(path);
        break;
    }
    case "validate-change-budget" when args.Length == 4:
    {
        await using var stream = File.OpenRead(args[3]);
        var budget = await JsonSerializer.DeserializeAsync(
            stream,
            DocumentJsonContext.Default.PackageChangeBudgetRequest)
            ?? throw new InvalidDataException("Package change budget JSON is empty.");
        var report = new PptxPackageChangeBudgetValidator().Validate(args[1], args[2], budget);
        await JsonSerializer.SerializeAsync(
            Console.OpenStandardOutput(),
            report,
            DocumentJsonContext.Default.PackageChangeBudgetReport);
        Console.WriteLine();
        if (!report.Valid) return 1;
        break;
    }
    default:
        Usage();
        return 2;
}

return 0;

static async Task WriteJson<T>(string path, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo)
{
    await using var stream = File.Create(path);
    await JsonSerializer.SerializeAsync(stream, value, typeInfo);
}

static void Usage() => Console.Error.WriteLine(
    "Usage: inspect <source.pptx> <graph.json> | extract-embedded-fonts <source.pptx> <output-dir> | validate-change-budget <baseline.pptx> <candidate.pptx> <budget.json>\n(previews and the font check come from the engine program present-pptx)");
