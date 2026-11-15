using System.Text.Json;
using Hongguo.Licensing;

// The new directory contains only this installation's SDK state, never a copied
// Windows store. Nothing in SavedLicense is emitted in the public RPC result.
sealed class PrivateLicenseStore : ILicenseStore
{
    private readonly object sync = new();
    private readonly string path;
    private readonly string deviceId;
    private SavedLicense current;
    public StoreHealth Health { get; private set; } = StoreHealth.Ok;

    public PrivateLicenseStore(string directory, string deviceId)
    {
        this.deviceId = deviceId;
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new BrokerFailure("state_directory_is_link");
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        path = Path.Combine(directory, "license-state.json");
        if (File.Exists(path))
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new BrokerFailure("state_file_is_link");
            var saved = JsonSerializer.Deserialize<StoredState>(File.ReadAllBytes(path))
                ?? throw new BrokerFailure("invalid_saved_state");
            if (saved.DeviceId != deviceId)
                throw new BrokerFailure("saved_device_mismatch");
            current = saved.License ?? throw new BrokerFailure("invalid_saved_state");
        }
        else
        {
            current = new SavedLicense();
        }
    }

    public SavedLicense Load()
    {
        lock (sync) return current;
    }

    public bool Update(Func<SavedLicense, SavedLicense> change)
    {
        lock (sync)
        {
            var next = change(current);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(new StoredState(deviceId, next));
                var creation = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows())
                    creation.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using (var stream = new FileStream(temporary, creation))
                {
                    stream.Write(bytes);
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temporary, path, overwrite: true);
                current = next;
                Health = StoreHealth.Ok;
                return true;
            }
            catch (IOException)
            {
                Health = StoreHealth.Unreadable;
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                Health = StoreHealth.Unreadable;
                return false;
            }
            finally
            {
                try { File.Delete(temporary); }
                catch (IOException) { /* A failed private-file cleanup remains an operator concern. */ }
                catch (UnauthorizedAccessException) { /* Preserve the original storage failure. */ }
            }
        }
    }

    private sealed record StoredState(string DeviceId, SavedLicense License);
}
