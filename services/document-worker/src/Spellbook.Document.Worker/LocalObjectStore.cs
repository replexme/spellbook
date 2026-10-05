using System.Text.Json;

public sealed class LocalObjectStore
{
    public const long DefaultReserveBytes = 512L * 1024 * 1024;
    public const long MinimumReserveBytes = 64L * 1024 * 1024;
    public const long MaximumReserveBytes = 1024L * 1024 * 1024 * 1024;
    public const long ControlReserveBytes = 16L * 1024 * 1024;
    public const long MaximumControlWriteBytes = 1024L * 1024;

    private readonly string root;
    private readonly long reserveBytes;
    private readonly Func<string, long> availableBytes;

    public LocalObjectStore()
        : this(
            Environment.GetEnvironmentVariable("SPELLBOOK_DATA_DIR") ?? ".spellbook/data",
            ParseReserveBytes(Environment.GetEnvironmentVariable("SPELLBOOK_STORAGE_RESERVE_BYTES")))
    {
    }

    public LocalObjectStore(string root, long reserveBytes, Func<string, long>? availableBytes = null)
    {
        this.root = Path.GetFullPath(root);
        this.reserveBytes = ValidateReserveBytes(reserveBytes);
        this.availableBytes = availableBytes ?? AvailableStorageBytes;
        Directory.CreateDirectory(this.root);
    }

    public static long ParseReserveBytes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return DefaultReserveBytes;
        if (!long.TryParse(value, out var bytes))
            throw new InvalidDataException(
                $"SPELLBOOK_STORAGE_RESERVE_BYTES must be an integer from {MinimumReserveBytes} to {MaximumReserveBytes}.");
        return ValidateReserveBytes(bytes);
    }

    public async Task<byte[]> ReadAsync(string objectName, CancellationToken cancellationToken) =>
        await File.ReadAllBytesAsync(Resolve(objectName), cancellationToken);

    public async Task DownloadAsync(string objectName, string destination, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        await using var source = File.OpenRead(Resolve(objectName));
        await using var target = File.Create(destination);
        await source.CopyToAsync(target, cancellationToken);
    }

    public async Task UploadFileAsync(string objectName, string sourcePath, CancellationToken cancellationToken)
    {
        await using var source = File.OpenRead(sourcePath);
        await UploadAsync(objectName, source, cancellationToken);
    }

    public async Task CopyAsync(string sourceObject, string destinationObject, CancellationToken cancellationToken)
    {
        await using var source = File.OpenRead(Resolve(sourceObject));
        await UploadAsync(destinationObject, source, cancellationToken);
    }

    public async Task UploadJsonAsync<T>(string objectName, T value, CancellationToken cancellationToken)
    {
        await using var data = new MemoryStream();
        await JsonSerializer.SerializeAsync(data, value, cancellationToken: cancellationToken);
        data.Position = 0;
        await UploadAsync(objectName, data, cancellationToken, false);
    }

    public async Task UploadJsonAsync<T>(string objectName, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken)
    {
        await using var data = new MemoryStream();
        await JsonSerializer.SerializeAsync(data, value, typeInfo, cancellationToken);
        data.Position = 0;
        await UploadAsync(objectName, data, cancellationToken, false);
    }

    public async Task UploadControlReceiptAsync<T>(string objectName, T value, CancellationToken cancellationToken)
    {
        await using var data = new MemoryStream();
        await JsonSerializer.SerializeAsync(data, value, cancellationToken: cancellationToken);
        data.Position = 0;
        await UploadAsync(objectName, data, cancellationToken, true);
    }

    public async Task<T?> TryReadJsonAsync<T>(string objectName, CancellationToken cancellationToken)
    {
        try
        {
            await using var source = File.OpenRead(Resolve(objectName));
            return await JsonSerializer.DeserializeAsync<T>(source, cancellationToken: cancellationToken);
        }
        catch (FileNotFoundException)
        {
            return default;
        }
        catch (DirectoryNotFoundException)
        {
            return default;
        }
    }

    private async Task UploadAsync(string objectName, Stream source, CancellationToken cancellationToken, bool controlReceipt = false)
    {
        if (!source.CanSeek)
            throw new InvalidDataException("storage_write_length_required");
        var writeBytes = checked(source.Length - source.Position);
        if (controlReceipt && writeBytes > MaximumControlWriteBytes)
            throw new InvalidDataException("storage_control_receipt_too_large");
        var requiredReserve = controlReceipt ? ControlReserveBytes : reserveBytes;
        if (availableBytes(root) - writeBytes < requiredReserve)
            throw new InvalidDataException("storage_capacity_exhausted");

        var destination = Resolve(objectName);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = $"{destination}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var target = File.Create(temporary))
                await source.CopyToAsync(target, cancellationToken);
            File.Move(temporary, destination, true);
        }
        catch (IOException exception) when (AvailableBytesOrZero() < requiredReserve)
        {
            throw new InvalidDataException("storage_capacity_exhausted", exception);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private long AvailableBytesOrZero()
    {
        try
        {
            return availableBytes(root);
        }
        catch
        {
            return 0;
        }
    }

    private string Resolve(string objectName)
    {
        if (string.IsNullOrWhiteSpace(objectName) || Path.IsPathRooted(objectName))
            throw new InvalidDataException("Unsafe object name.");
        var segments = objectName.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(segment => segment is "." or ".."))
            throw new InvalidDataException("Unsafe object name.");
        var result = Path.GetFullPath(Path.Combine(root, Path.Combine(segments)));
        if (!result.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidDataException("Unsafe object name.");
        return result;
    }

    private static long ValidateReserveBytes(long bytes)
    {
        if (bytes < MinimumReserveBytes || bytes > MaximumReserveBytes)
            throw new InvalidDataException(
                $"SPELLBOOK_STORAGE_RESERVE_BYTES must be an integer from {MinimumReserveBytes} to {MaximumReserveBytes}.");
        return bytes;
    }

    private static long AvailableStorageBytes(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var drive = DriveInfo.GetDrives()
            .Where(candidate => candidate.IsReady && IsWithin(fullPath, candidate.RootDirectory.FullName))
            .OrderByDescending(candidate => candidate.RootDirectory.FullName.Length)
            .FirstOrDefault();
        if (drive is null)
            throw new IOException($"Cannot determine free storage for {fullPath}.");
        return drive.AvailableFreeSpace;
    }

    private static bool IsWithin(string path, string rootPath)
    {
        var root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar);
        if (root.Length == 0)
            root = Path.DirectorySeparatorChar.ToString();
        return path.Equals(root, StringComparison.Ordinal) ||
               path.StartsWith(root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }
}
