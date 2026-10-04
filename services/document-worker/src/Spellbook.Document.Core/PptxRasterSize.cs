using System.IO.Compression;
using System.Xml.Linq;

namespace Spellbook.Document.Core;

public readonly record struct PptxRasterSize(int Width, int Height)
{
    private const double EmuPerInch = 914400d;
    public const long MaxPixelsPerSlide = 16_000_000;

    public static PptxRasterSize Read(string pptxPath, int dotsPerInch)
    {
        if (dotsPerInch <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(dotsPerInch),
                dotsPerInch,
                "Raster resolution must be positive.");
        }

        using var archive = ZipFile.OpenRead(pptxPath);
        var entry = archive.GetEntry("ppt/presentation.xml")
            ?? throw new InvalidDataException("The package has no presentation part.");
        using var stream = entry.Open();
        var document = XDocument.Load(stream, LoadOptions.None);
        var slideSize = document
            .Descendants()
            .FirstOrDefault(element => element.Name.LocalName == "sldSz")
            ?? throw new InvalidDataException("The presentation has no slide size.");
        var widthEmu = ParseDimension(slideSize, "cx", "Slide width is missing.");
        var heightEmu = ParseDimension(slideSize, "cy", "Slide height is missing.");

        var size = new PptxRasterSize(
            ToPixels(widthEmu, dotsPerInch),
            ToPixels(heightEmu, dotsPerInch));
        if ((long)size.Width * size.Height > MaxPixelsPerSlide)
            throw new InvalidDataException(PptxImagePixelBudget.RejectionCode);
        return size;
    }

    private static long ParseDimension(XElement slideSize, string attribute, string message)
    {
        if (!long.TryParse((string?)slideSize.Attribute(attribute), out var value) || value <= 0)
        {
            throw new InvalidDataException(message);
        }
        return value;
    }

    private static int ToPixels(long emu, int dotsPerInch)
    {
        var pixels = Math.Round(
            emu * dotsPerInch / EmuPerInch,
            MidpointRounding.AwayFromZero);
        if (pixels is < 1 or > int.MaxValue)
        {
            throw new InvalidDataException("The slide size cannot be rasterized safely.");
        }
        return checked((int)pixels);
    }
}
