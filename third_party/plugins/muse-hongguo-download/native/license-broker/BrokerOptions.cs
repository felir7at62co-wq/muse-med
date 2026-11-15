using System.Text.Json;
using System.Text.RegularExpressions;

sealed record BrokerOptions(string DeviceId, string StateDirectory, string AppVersion, int MaxLineBytes, int MaxPendingRequests)
{
    public static BrokerOptions Parse(string[] args)
    {
        if (args.Length != 2 || args[0] != "--config" || !Path.IsPathFullyQualified(args[1]))
            throw new BrokerFailure("private_config_required");
        using var document = ReadPrivate(args[1]);
        var config = document.RootElement;
        var deviceFile = config.GetProperty("deviceFile").GetString();
        if (deviceFile is null || !Path.IsPathFullyQualified(deviceFile))
            throw new BrokerFailure("private_device_file_required");
        using var deviceDocument = ReadPrivate(deviceFile);
        var device = deviceDocument.RootElement;
        var platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : null;
        if (platform is null || device.GetProperty("version").GetInt32() != 1
            || device.GetProperty("platform").GetString() != platform)
            throw new BrokerFailure("invalid_device_record");
        var deviceId = device.GetProperty("deviceId").GetString();
        if (deviceId is null || !Regex.IsMatch(deviceId, "\\Ad1:[0-9a-f]{32}\\z", RegexOptions.CultureInvariant))
            throw new BrokerFailure("invalid_device_id");
        var stateDirectory = config.GetProperty("stateDirectory").GetString();
        if (stateDirectory is null || !Path.IsPathFullyQualified(stateDirectory))
            throw new BrokerFailure("state_directory_must_be_absolute");
        var appVersion = config.GetProperty("appVersion").GetString();
        if (string.IsNullOrWhiteSpace(appVersion)) throw new BrokerFailure("app_version_required");
        var maxLineBytes = config.GetProperty("maxLineBytes").GetInt32();
        var maxPendingRequests = config.GetProperty("maxPendingRequests").GetInt32();
        if (maxLineBytes < 1 || maxPendingRequests < 1) throw new BrokerFailure("invalid_limits");
        return new(deviceId, Path.GetFullPath(stateDirectory), appVersion, maxLineBytes, maxPendingRequests);
    }

    private static JsonDocument ReadPrivate(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new BrokerFailure("private_file_is_link");
        if (!OperatingSystem.IsWindows()
            && (File.GetUnixFileMode(path) & ~(UnixFileMode.UserRead | UnixFileMode.UserWrite)) != 0)
            throw new BrokerFailure("file_must_be_private");
        if (new FileInfo(path).Length > 16_384) throw new BrokerFailure("private_file_too_large");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }
}
