<# Compile the reviewed helper once for the main native test and its isolated diagnostic observers. #>
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$AssemblyPath)
if ($AssemblyPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
    throw 'Installer diagnostics assembly requires a fully qualified Windows path'
}
$installerDiagnosticsAssemblyFile = [IO.Path]::GetFullPath($AssemblyPath)
if (-not [string]::Equals([IO.Path]::GetExtension($installerDiagnosticsAssemblyFile), '.dll', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer diagnostics assembly must be a DLL'
}
if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($installerDiagnosticsAssemblyFile))) {
    throw 'Installer diagnostics assembly requires its allocated private directory'
}
if (Test-Path -LiteralPath $installerDiagnosticsAssemblyFile) {
    throw 'Installer diagnostics refuses a preexisting assembly destination'
}
if ('InstallerDiagnostics' -as [type]) {
    throw 'Installer diagnostics cannot replace an already loaded helper type'
}
# Disk compilation without PassThru does not load types in Windows PowerShell 5.
Add-Type -ReferencedAssemblies System.dll, System.Core.dll -OutputAssembly $installerDiagnosticsAssemblyFile -OutputType Library -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Read-only observations for an owned installer; no privilege adjustment or process memory reads.
public static class InstallerDiagnostics {
    const uint TokenQuery = 0x0008;
    const int TokenElevationType = 18, TokenElevation = 20;
    const uint WctOutOfProcess = 0x1, WctOutOfProcessCom = 0x2, WctOutOfProcessCs = 0x4;
    const int WctMaxNodeCount = 16, WctThreadType = 8;
    const int ErrorMoreData = 234, ErrorTooManyThreads = 565;
    const uint GwOwner = 4, GaParent = 1;
    const uint LoadLibrarySearchSystem32 = 0x00000800;
    static readonly object comRegistrationLock = new object();
    static readonly ComCallbackRegistration comRegistration = new ComCallbackRegistration();
    static IntPtr retainedOle32Module;

    public sealed class TokenElevationObservation {
        public bool? Elevated;
        public uint? ElevationType;
        public int? OpenTokenError, ElevationError, ElevationTypeError, CloseTokenError;
    }

    public sealed class ComCallbackRegistration {
        public bool Attempted, Registered;
        public int? LoadLibraryError, CallStateAddressError, ActivationStateAddressError, RegistrationError;
    }

    public sealed class WindowObservation {
        public long Handle, ParentHandle, OwnerHandle;
        public uint ProcessId, ThreadId;
        public string ClassName, Title;
        public bool Exists, Visible, Enabled, ClassNameMayBeTruncated, TitleMayBeTruncated;
        public int? ClassNameError, TitleError;
    }

    public sealed class WaitChainNodeObservation {
        public int ObjectType, ObjectStatus;
        public uint? ProcessId, ThreadId, WaitTime, ContextSwitches;
    }

    public sealed class WaitChainObservation {
        public bool QuerySucceeded, Truncated;
        public bool? IsCycle;
        public uint NodeCount;
        public int? Win32Error;
        public WaitChainNodeObservation[] Nodes = new WaitChainNodeObservation[0];
    }

    public sealed class ThreadObservation {
        public uint ThreadId;
        public int? ManagedState, ManagedWaitReason, ManagedStateError, ManagedWaitReasonError;
        public WaitChainObservation WaitChain;
    }

    public sealed class FailureObservation {
        public int ProcessId;
        public string CapturedUtc;
        public long ElapsedMs;
        public WindowObservation[] Windows = new WindowObservation[0];
        public ThreadObservation[] Threads = new ThreadObservation[0];
        public int? ThreadEnumerationError, WindowEnumerationError, WctSessionError;
        public int[] WindowObservationErrors = new int[0];
        public bool WctSessionClosed;
        public bool ComCallbacksRegisteredByHelper = false;
        public ComCallbackRegistration ComRegistration = new ComCallbackRegistration();
    }

    // wct.h: two 32-bit enums precede a 272-byte union, aligned to eight bytes.
    // Only ThreadObject is projected; the union's UTF-16 object name is never decoded or emitted.
    // https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/wct.h
    [StructLayout(LayoutKind.Explicit, Size = 280)]
    struct NativeWaitChainNode {
        [FieldOffset(0)] public int ObjectType;
        [FieldOffset(4)] public int ObjectStatus;
        [FieldOffset(8)] public uint ProcessId;
        [FieldOffset(12)] public uint ThreadId;
        [FieldOffset(16)] public uint WaitTime;
        [FieldOffset(20)] public uint ContextSwitches;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetTokenInformation(IntPtr token, int kind, out uint value, uint size, out uint requiredSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern IntPtr OpenThreadWaitChainSession(uint flags, IntPtr callback);
    [DllImport("advapi32.dll")] static extern void CloseThreadWaitChainSession(IntPtr session);
    [DllImport("advapi32.dll")]
    static extern void RegisterWaitChainCOMCallback(IntPtr callState, IntPtr activationState);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetThreadWaitChain(IntPtr session, UIntPtr context, uint flags, uint thread,
        ref uint nodeCount, [Out, MarshalAs(UnmanagedType.LPArray, SizeConst = WctMaxNodeCount)] NativeWaitChainNode[] nodes,
        [MarshalAs(UnmanagedType.Bool)] out bool isCycle);

    delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool EnumThreadWindows(uint thread, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetClassName(IntPtr window, StringBuilder value, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetWindowText(IntPtr window, StringBuilder value, int count);

    /// <summary>Reads the primary token using a borrowed handle; the caller retains process ownership.</summary>
    /// <param name="processHandle">A live Process-owned handle with query access, retained by the caller.</param>
    /// <returns>Independent elevation observations and numeric API errors; unavailable values remain null.</returns>
    public static TokenElevationObservation ObserveTokenElevation(IntPtr processHandle) {
        if (processHandle == IntPtr.Zero) throw new ArgumentException("A retained process handle is required", "processHandle");
        var result = new TokenElevationObservation();
        IntPtr token;
        if (!OpenProcessToken(processHandle, TokenQuery, out token)) {
            result.OpenTokenError = Marshal.GetLastWin32Error();
            return result;
        }
        try {
            uint value, size;
            if (GetTokenInformation(token, TokenElevation, out value, 4, out size)) result.Elevated = value != 0;
            else result.ElevationError = Marshal.GetLastWin32Error();
            if (GetTokenInformation(token, TokenElevationType, out value, 4, out size)) result.ElevationType = value;
            else result.ElevationTypeError = Marshal.GetLastWin32Error();
        } finally {
            // Only this newly opened token is closed; never close the borrowed process handle.
            if (!CloseHandle(token)) result.CloseTokenError = Marshal.GetLastWin32Error();
        }
        return result;
    }

    /// <summary>Compares the retained process's executable path without enumerating modules or returning that path.</summary>
    /// <param name="processHandle">The observer-owned retained process handle, not closed by this method.</param>
    /// <param name="installerPath">The parent's exact installer executable path.</param>
    /// <returns>Whether normalized Windows paths match, ignoring case; a failed native query throws its numeric error.</returns>
    public static bool MatchesInstallerPath(IntPtr processHandle, string installerPath) {
        var image = new StringBuilder(32768);
        uint size = (uint)image.Capacity;
        if (!QueryFullProcessImageName(processHandle, 0, image, ref size))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the retained installer image");
        return String.Equals(System.IO.Path.GetFullPath(image.ToString()), System.IO.Path.GetFullPath(installerPath), StringComparison.OrdinalIgnoreCase);
    }

    static int ErrorCode(Exception error) {
        var native = error as Win32Exception;
        return native == null ? error.HResult : native.NativeErrorCode;
    }

    static ComCallbackRegistration CopyComRegistration() {
        return new ComCallbackRegistration {
            Attempted = comRegistration.Attempted, Registered = comRegistration.Registered,
            LoadLibraryError = comRegistration.LoadLibraryError, CallStateAddressError = comRegistration.CallStateAddressError,
            ActivationStateAddressError = comRegistration.ActivationStateAddressError, RegistrationError = comRegistration.RegistrationError
        };
    }

    /// <summary>Registers Ole32 WCT callbacks once in a dedicated diagnostic process, without adjusting privileges.</summary>
    /// <returns>Registration observations and numeric errors. The Ole32 module remains loaded until this process exits,
    /// because WCT stores process-global callback addresses; call only from the isolated failure observer.</returns>
    public static ComCallbackRegistration RegisterComCallbacksForObserver() {
        lock (comRegistrationLock) {
            if (comRegistration.Attempted) return CopyComRegistration();
            comRegistration.Attempted = true;
            try {
                retainedOle32Module = LoadLibraryEx("ole32.dll", IntPtr.Zero, LoadLibrarySearchSystem32);
                if (retainedOle32Module == IntPtr.Zero) {
                    comRegistration.LoadLibraryError = Marshal.GetLastWin32Error();
                    return CopyComRegistration();
                }
                IntPtr callState = GetProcAddress(retainedOle32Module, "CoGetCallState");
                if (callState == IntPtr.Zero) comRegistration.CallStateAddressError = Marshal.GetLastWin32Error();
                IntPtr activationState = GetProcAddress(retainedOle32Module, "CoGetActivationState");
                if (activationState == IntPtr.Zero) comRegistration.ActivationStateAddressError = Marshal.GetLastWin32Error();
                if (callState == IntPtr.Zero || activationState == IntPtr.Zero) return CopyComRegistration();
                RegisterWaitChainCOMCallback(callState, activationState);
                comRegistration.Registered = true;
            } catch (Exception error) { comRegistration.RegistrationError = ErrorCode(error); }
            return CopyComRegistration();
        }
    }

    static WaitChainObservation ObserveWaitChain(IntPtr session, uint thread) {
        var result = new WaitChainObservation();
        var nodes = new NativeWaitChainNode[WctMaxNodeCount];
        uint count = WctMaxNodeCount;
        bool cycle;
        result.QuerySucceeded = GetThreadWaitChain(session, UIntPtr.Zero,
            WctOutOfProcess | WctOutOfProcessCom | WctOutOfProcessCs, thread, ref count, nodes, out cycle);
        if (!result.QuerySucceeded) result.Win32Error = Marshal.GetLastWin32Error();
        result.NodeCount = count;
        // These two documented failures retain a valid partial chain, unlike access or thread-not-found errors.
        bool validNodes = result.QuerySucceeded || result.Win32Error == ErrorMoreData || result.Win32Error == ErrorTooManyThreads;
        if (!validNodes) return result;
        if (result.QuerySucceeded) result.IsCycle = cycle;
        result.Truncated = count > WctMaxNodeCount || !result.QuerySucceeded;
        var observations = new List<WaitChainNodeObservation>();
        for (int index = 0; index < Math.Min(count, (uint)WctMaxNodeCount); index++) {
            var node = nodes[index];
            var observation = new WaitChainNodeObservation { ObjectType = node.ObjectType, ObjectStatus = node.ObjectStatus };
            if (node.ObjectType == WctThreadType) {
                observation.ProcessId = node.ProcessId;
                observation.ThreadId = node.ThreadId;
                observation.WaitTime = node.WaitTime;
                observation.ContextSwitches = node.ContextSwitches;
            }
            observations.Add(observation);
        }
        result.Nodes = observations.ToArray();
        return result;
    }

    static WindowObservation ObserveWindow(IntPtr window, uint process, uint thread) {
        var result = new WindowObservation {
            Handle = window.ToInt64(), ParentHandle = GetAncestor(window, GaParent).ToInt64(),
            OwnerHandle = GetWindow(window, GwOwner).ToInt64(), ProcessId = process, ThreadId = thread,
            Exists = IsWindow(window), Visible = IsWindowVisible(window), Enabled = IsWindowEnabled(window)
        };
        var className = new StringBuilder(256);
        SetLastError(0);
        int classLength = GetClassName(window, className, className.Capacity);
        int classError = Marshal.GetLastWin32Error();
        result.ClassName = className.ToString();
        result.ClassNameMayBeTruncated = classLength == className.Capacity - 1;
        if (classLength == 0 && classError != 0) result.ClassNameError = classError;
        var title = new StringBuilder(4096);
        SetLastError(0);
        // Cross-process cached captions avoid sending WM_GETTEXT into the blocked installer.
        // Control contents without a caption can consequently be empty.
        int titleLength = GetWindowText(window, title, title.Capacity);
        int titleError = Marshal.GetLastWin32Error();
        result.Title = title.ToString();
        result.TitleMayBeTruncated = titleLength == title.Capacity - 1;
        if (titleLength == 0 && titleError != 0) result.TitleError = titleError;
        return result;
    }

    static void ObserveWindows(FailureObservation result) {
        var windows = new List<WindowObservation>();
        var seen = new HashSet<long>();
        var errors = new List<int>();
        WindowCallback capture = delegate(IntPtr window, IntPtr unused) {
            try {
                uint owner;
                uint thread = GetWindowThreadProcessId(window, out owner);
                if (owner == result.ProcessId && seen.Add(window.ToInt64())) windows.Add(ObserveWindow(window, owner, thread));
            } catch (Exception error) {
                // No managed exception may cross the synchronous native enumeration callback.
                errors.Add(ErrorCode(error));
            }
            return true;
        };
        WindowCallback root = delegate(IntPtr window, IntPtr unused) {
            capture(window, IntPtr.Zero);
            try {
                // Recurses over descendants, without excluding invisible roots or foreign-process parents.
                EnumChildWindows(window, capture, IntPtr.Zero);
            } catch (Exception error) {
                errors.Add(ErrorCode(error));
            }
            return true;
        };
        SetLastError(0);
        if (!EnumWindows(root, IntPtr.Zero)) result.WindowEnumerationError = Marshal.GetLastWin32Error();
        foreach (var thread in result.Threads) {
            // Thread enumeration also covers nonchild windows not reached by the desktop roots.
            // FALSE can simply mean that this thread has no windows, so it is not an API error receipt.
            EnumThreadWindows(thread.ThreadId, root, IntPtr.Zero);
        }
        windows.Sort(delegate(WindowObservation left, WindowObservation right) { return left.Handle.CompareTo(right.Handle); });
        result.Windows = windows.ToArray();
        result.WindowObservationErrors = errors.ToArray();
    }

    /// <summary>Samples hidden and visible windows and managed thread states without issuing WCT queries.</summary>
    /// <param name="process">The test-owned Process, still retained and not disposed by its cleanup.</param>
    /// <returns>A snapshot suitable for saving before the diagnostic worker enters a blocking native query.</returns>
    public static FailureObservation CaptureFailureSnapshot(Process process) {
        if (process == null) throw new ArgumentNullException("process");
        var timer = Stopwatch.StartNew();
        var result = new FailureObservation { ProcessId = process.Id, CapturedUtc = DateTime.UtcNow.ToString("O") };
        var threads = new List<ThreadObservation>();
        try {
            foreach (ProcessThread thread in process.Threads) {
                try {
                    var observation = new ThreadObservation { ThreadId = (uint)thread.Id };
                    threads.Add(observation);
                    try {
                        var state = thread.ThreadState;
                        observation.ManagedState = (int)state;
                        if (state == System.Diagnostics.ThreadState.Wait) {
                            try { observation.ManagedWaitReason = (int)thread.WaitReason; }
                            catch (Exception error) { observation.ManagedWaitReasonError = ErrorCode(error); }
                        }
                    } catch (Exception error) { observation.ManagedStateError = ErrorCode(error); }
                } finally {
                    thread.Dispose();
                }
            }
        } catch (Exception error) { result.ThreadEnumerationError = ErrorCode(error); }
        threads.Sort(delegate(ThreadObservation left, ThreadObservation right) { return left.ThreadId.CompareTo(right.ThreadId); });
        result.Threads = threads.ToArray();
        ObserveWindows(result);
        result.ComRegistration = CopyComRegistration();
        result.ComCallbacksRegisteredByHelper = result.ComRegistration.Registered;
        timer.Stop();
        result.ElapsedMs = timer.ElapsedMilliseconds;
        return result;
    }

    /// <summary>Adds synchronous numeric WCT observations to an already saved snapshot.</summary>
    /// <param name="result">An owned installer's snapshot captured in this diagnostic process.</param>
    /// <remarks>Native queries cannot be cancelled and can block this caller. The parent owns a bounded observer
    /// process and waits for its exit after termination; this method creates no background callbacks or threads.</remarks>
    public static void PopulateWaitChains(FailureObservation result) {
        if (result == null) throw new ArgumentNullException("result");
        var timer = Stopwatch.StartNew();
        result.ComRegistration = CopyComRegistration();
        result.ComCallbacksRegisteredByHelper = result.ComRegistration.Registered;
        // Synchronous WCT has no background callbacks; close only after every query has returned.
        // Privilege-limited, exited-thread, unsupported-lock and partial-chain results are not proof of no wait.
        // Without successful explicit COM registration, missing COM edges remain inconclusive.
        // https://learn.microsoft.com/en-us/windows/win32/debug/using-wct
        IntPtr session = OpenThreadWaitChainSession(0, IntPtr.Zero);
        if (session == IntPtr.Zero) result.WctSessionError = Marshal.GetLastWin32Error();
        else {
            try {
                foreach (var thread in result.Threads) thread.WaitChain = ObserveWaitChain(session, thread.ThreadId);
            } finally {
                CloseThreadWaitChainSession(session);
                result.WctSessionClosed = true;
            }
        }
        timer.Stop();
        result.ElapsedMs += timer.ElapsedMilliseconds;
    }

    /// <summary>Samples windows and synchronous numeric WCT waits in a diagnostic process.</summary>
    /// <param name="process">The diagnostic worker's owned Process, retained until worker cleanup.</param>
    /// <returns>Best-effort observations. Windows can block this caller during noncancellable WCT queries;
    /// use the snapshot and populate methods when evidence must be saved before those queries.</returns>
    public static FailureObservation CaptureFailure(Process process) {
        var result = CaptureFailureSnapshot(process);
        PopulateWaitChains(result);
        return result;
    }
}
'@
Add-Type -LiteralPath $installerDiagnosticsAssemblyFile
if (-not ('InstallerDiagnostics' -as [type])) {
    throw 'The compiled installer diagnostics assembly did not provide its helper type'
}
