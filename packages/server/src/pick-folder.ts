// Opens the operating system's own folder dialog on the machine that runs the server (always the user's own computer:
// the server listens on 127.0.0.1 only). Browsers cannot hand a real folder path to a web page, so the server asks the OS.

import { execFile } from 'node:child_process';

export type PickResult = { supported: false } | { supported: true; path: string | null };

// Windows: the Explorer-style "Select Folder" dialog (IFileOpenDialog with FOS_PICKFOLDERS), owned by the foreground window.
const WINDOWS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentDeskFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCoClass {}
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc, ref Guid riid, out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Pick(string title, string start) {
    IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogCoClass();
    uint options; dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800);
    if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try { Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"); IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder); dialog.SetFolder(folder); } catch { }
    }
    int hr = dialog.Show(GetForegroundWindow());
    if (hr != 0) return "";
    IShellItem item; dialog.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path);
    return path;
  }
}
"@
$picked = [AgentDeskFolderPicker]::Pick($env:AGENT_DESK_PICK_TITLE, $env:AGENT_DESK_PICK_START)
[Console]::Out.Write($picked)
`;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 10 * 60 * 1000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        // osascript exits 1 when the user cancels; treat any non-start failure with no output as a cancel
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(error); else resolve(null);
        return;
      }
      const text = stdout.trim();
      resolve(text === '' ? null : text);
    });
  });
}

export async function pickFolderNative(platform: NodeJS.Platform, startPath: string, title: string, env: NodeJS.ProcessEnv): Promise<PickResult> {
  try {
    if (platform === 'win32') {
      const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      const path = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { ...env, AGENT_DESK_PICK_TITLE: title, AGENT_DESK_PICK_START: startPath });
      return { supported: true, path };
    }
    if (platform === 'darwin') {
      const path = await run('osascript', ['-e', 'POSIX path of (choose folder)'], env);
      return { supported: true, path: path ? path.replace(/\/$/, '') || '/' : null };
    }
  } catch {
    return { supported: false };
  }
  return { supported: false };
}
