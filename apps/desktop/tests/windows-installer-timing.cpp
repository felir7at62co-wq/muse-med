#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <cassert>
#include <string>

extern "C" __declspec(dllimport) int __cdecl InstallerRecordTiming(LPCWSTR directory, LPCWSTR version, int eventCode);

static std::string ReadBytes(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    LARGE_INTEGER size = {};
    assert(GetFileSizeEx(file, &size));
    assert(size.QuadPart > 0 && size.QuadPart < 65536);
    std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
    DWORD read = 0;
    assert(ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr));
    assert(read == static_cast<DWORD>(bytes.size()));
    CloseHandle(file);
    return bytes;
}

int wmain() {
    WCHAR temp[MAX_PATH];
    const DWORD length = GetTempPathW(ARRAYSIZE(temp), temp);
    assert(length > 0 && length < ARRAYSIZE(temp));
    const std::wstring root = std::wstring(temp) + L"dsh-installer-timing-" + std::to_wstring(GetCurrentProcessId());
    assert(CreateDirectoryW(root.c_str(), nullptr));
    assert(InstallerRecordTiming((root + L"\\missing").c_str(), L"1.2.3", 0) == 0);
    assert(InstallerRecordTiming(root.c_str(), L"bad\"version", 0) == 0);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 0) == 1);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 1) == 1);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 2) == 1);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 3) == 1);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 4) == 1);
    assert(InstallerRecordTiming(root.c_str(), L"1.2.3-nightly.4", 5) == 1);

    WIN32_FIND_DATAW found = {};
    HANDLE search = FindFirstFileW((root + L"\\installer-*.jsonl").c_str(), &found);
    assert(search != INVALID_HANDLE_VALUE);
    assert(FindNextFileW(search, &found) == FALSE && GetLastError() == ERROR_NO_MORE_FILES);
    FindClose(search);
    const std::wstring path = root + L"\\" + found.cFileName;
    const std::string bytes = ReadBytes(path);
    for (const char* event : {"installer-started", "previous-process-wait-started", "previous-process-wait-completed",
        "installer-extract-started", "installer-extract-completed", "installer-completed"}) {
        assert(bytes.find(std::string("\"event\":\"") + event + "\"") != std::string::npos);
    }
    assert(bytes.find("\"schemaVersion\":2") != std::string::npos);
    assert(bytes.find("\"processType\":\"windows-installer\"") != std::string::npos);
    assert(bytes.find("\"durationMs\":") != std::string::npos);
    assert(bytes.find("\"version\":\"1.2.3-nightly.4\"") != std::string::npos);
    assert(bytes.find("dsh-installer-timing") == std::string::npos);
    assert(bytes.find("\"sequence\":5") != std::string::npos);

    assert(DeleteFileW(path.c_str()));
    assert(RemoveDirectoryW(root.c_str()));
    return 0;
}
