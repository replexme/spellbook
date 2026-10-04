using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;

namespace Spellbook.Document.Core;

/// <summary>
/// Rejects a package before rendering when its raster images would decode to
/// more pixels than the worker can hold in memory. Only image headers are read
/// (PNG, JPEG, GIF, BMP); no pixel data is decoded. Formats whose size cannot be
/// read cheaply from a fixed header (EMF, WMF, SVG, TIFF, WebP) are not counted.
/// </summary>
public sealed class PptxImagePixelBudget
{
    public const long DefaultMaxImagePixels = 100_000_000;
    public const long DefaultMaxTotalImagePixels = 400_000_000;
    public const string RejectionCode = "image_too_large";
    private const int FixedHeaderBytes = 26;
    // JPEG frame headers follow metadata segments (EXIF, ICC, XMP). Real files
    // reach the frame header within a few hundred KB; stop scanning after this.
    private const int MaxJpegHeaderBytes = 2 * 1024 * 1024;

    private readonly long maxImagePixels;
    private readonly long maxTotalImagePixels;

    public PptxImagePixelBudget(
        long maxImagePixels = DefaultMaxImagePixels,
        long maxTotalImagePixels = DefaultMaxTotalImagePixels)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxImagePixels);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxTotalImagePixels);
        this.maxImagePixels = maxImagePixels;
        this.maxTotalImagePixels = maxTotalImagePixels;
    }

    /// <summary>
    /// SPELLBOOK_MAX_IMAGE_PIXELS and SPELLBOOK_MAX_TOTAL_IMAGE_PIXELS override
    /// the defaults with a positive whole number; any other value uses the default.
    /// </summary>
    public static PptxImagePixelBudget FromEnvironment() => new(
        LimitFrom("SPELLBOOK_MAX_IMAGE_PIXELS", DefaultMaxImagePixels),
        LimitFrom("SPELLBOOK_MAX_TOTAL_IMAGE_PIXELS", DefaultMaxTotalImagePixels));

    public void Check(string pptxPath)
    {
        using var archive = ZipFile.OpenRead(pptxPath);
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            if (entry.FullName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase) ||
                entry.FullName.EndsWith(".rels", StringComparison.OrdinalIgnoreCase))
                continue;
            long? pixels;
            try
            {
                pixels = ReadPixels(entry);
            }
            catch (Exception exception) when (exception is InvalidDataException or IOException)
            {
                // An unreadable part is not this guard's concern; the renderer
                // has always skipped or reported damaged media on its own.
                continue;
            }
            if (pixels is null) continue;
            total = pixels.Value > long.MaxValue - total ? long.MaxValue : total + pixels.Value;
            if (pixels.Value > maxImagePixels || total > maxTotalImagePixels)
                throw new InvalidDataException(RejectionCode);
        }
    }

    internal static long? ReadPixels(ZipArchiveEntry entry)
    {
        Span<byte> header = stackalloc byte[FixedHeaderBytes];
        int read;
        using (var stream = entry.Open())
            read = stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false);
        header = header[..read];
        if (header.Length >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        {
            using var stream = entry.Open();
            return JpegPixels(stream);
        }
        if (header.Length >= 24 &&
            header[..8].SequenceEqual((ReadOnlySpan<byte>)[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) &&
            header[12..16].SequenceEqual("IHDR"u8))
            return Pixels(
                BinaryPrimitives.ReadUInt32BigEndian(header[16..]),
                BinaryPrimitives.ReadUInt32BigEndian(header[20..]));
        if (header.Length >= 10 &&
            (header[..6].SequenceEqual("GIF87a"u8) || header[..6].SequenceEqual("GIF89a"u8)))
            return Pixels(
                BinaryPrimitives.ReadUInt16LittleEndian(header[6..]),
                BinaryPrimitives.ReadUInt16LittleEndian(header[8..]));
        if (header.Length >= 26 && header[0] == (byte)'B' && header[1] == (byte)'M')
        {
            var dibHeaderSize = BinaryPrimitives.ReadUInt32LittleEndian(header[14..]);
            if (dibHeaderSize == 12)
                return Pixels(
                    BinaryPrimitives.ReadUInt16LittleEndian(header[18..]),
                    BinaryPrimitives.ReadUInt16LittleEndian(header[20..]));
            if (dibHeaderSize >= 40)
                return Pixels(
                    (ulong)Math.Abs((long)BinaryPrimitives.ReadInt32LittleEndian(header[18..])),
                    (ulong)Math.Abs((long)BinaryPrimitives.ReadInt32LittleEndian(header[22..])));
        }
        return null;
    }

    private static long? JpegPixels(Stream stream)
    {
        using var input = new BufferedStream(stream, 4096);
        var position = 0;
        int Next()
        {
            if (position >= MaxJpegHeaderBytes) return -1;
            var value = input.ReadByte();
            if (value >= 0) position++;
            return value;
        }

        if (Next() != 0xFF || Next() != 0xD8) return null;
        while (true)
        {
            if (Next() != 0xFF) return null;
            int marker;
            do marker = Next(); while (marker == 0xFF);
            if (marker < 0 || marker is 0xD9 or 0xDA) return null;
            if (marker is 0x01 or >= 0xD0 and <= 0xD7) continue;
            var high = Next();
            var low = Next();
            if (low < 0) return null;
            var length = (high << 8) | low;
            if (length < 2) return null;
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
            if (marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC)
            {
                if (length < 7 || Next() < 0) return null;
                var height = (Next() << 8) | Next();
                var width = (Next() << 8) | Next();
                return height < 0 || width < 0 ? null : Pixels((ulong)width, (ulong)height);
            }
            for (var skipped = 2; skipped < length; skipped++)
                if (Next() < 0) return null;
        }
    }

    private static long Pixels(ulong width, ulong height) =>
        width != 0 && height > (ulong)long.MaxValue / width
            ? long.MaxValue
            : (long)(width * height);

    private static long LimitFrom(string name, long fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        if (long.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var limit) && limit > 0)
            return limit;
        Console.Error.WriteLine(JsonSerializer.Serialize(new
        {
            eventType = "image_pixel_limit_config_ignored",
            name,
            fallback
        }));
        return fallback;
    }
}
