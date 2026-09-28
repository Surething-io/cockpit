/**
 * /api/pick-folder
 *
 * Launches the OS-native folder picker dialog. Returns `folder: null` on
 * failure or user cancellation.
 */
import { execFile } from "child_process"
import { homedir } from "os"
import { Effect } from "effect"
import { SETTINGS_FILE, readJsonFile } from "@cockpit/shared-utils"
import en from "@cockpit/shared-i18n/locales/en.json"
import zh from "@cockpit/shared-i18n/locales/zh.json"
import { handler, ok } from "@cockpit/effect-runtime/server"

const locales: Record<string, typeof en> = { en, zh }

// JXA NSOpenPanel instead of AppleScript `choose folder`: a bare osascript
// process has no main menu, so Cmd+V/C/X/A have no Edit-menu key equivalents
// to route through and paste silently does nothing (e.g. in Cmd+Shift+G "Go to
// Folder"). Installing a minimal Edit menu restores the standard shortcuts.
const MAC_PICKER_JXA = `
ObjC.import("AppKit")
function run(argv) {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const edit = $.NSMenu.alloc.initWithTitle("Edit")
  edit.addItemWithTitleActionKeyEquivalent("Undo", "undo:", "z")
  edit.addItemWithTitleActionKeyEquivalent("Cut", "cut:", "x")
  edit.addItemWithTitleActionKeyEquivalent("Copy", "copy:", "c")
  edit.addItemWithTitleActionKeyEquivalent("Paste", "paste:", "v")
  edit.addItemWithTitleActionKeyEquivalent("Select All", "selectAll:", "a")
  const editItem = $.NSMenuItem.alloc.init
  editItem.submenu = edit
  const mainMenu = $.NSMenu.alloc.init
  mainMenu.addItem(editItem)
  app.mainMenu = mainMenu
  // Without this the app never completes launch: keys still reach the panel,
  // but mouse clicks are swallowed and it exposes no accessibility windows.
  app.finishLaunching
  app.activateIgnoringOtherApps(true)
  const panel = $.NSOpenPanel.openPanel
  panel.canChooseFiles = false
  panel.canChooseDirectories = true
  panel.canCreateDirectories = true
  panel.allowsMultipleSelection = false
  panel.message = argv[0]
  panel.directoryURL = $.NSURL.fileURLWithPath(argv[1])
  return panel.runModal == $.NSModalResponseOK ? panel.URL.path.js : ""
}
`

// Windows: IFileOpenDialog with FOS_PICKFOLDERS instead of WinForms
// FolderBrowserDialog. The latter (Windows PowerShell 5.1 = .NET Framework)
// is the legacy tree view with no address bar, so a path cannot be pasted at
// all. Inputs arrive via env vars and the script via -EncodedCommand, so
// nothing user-controlled is ever parsed by PowerShell.
const WIN_PICKER_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CockpitFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem item);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  public static string Pick(string title, string start) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    dialog.SetTitle(title);
    try {
      IShellItem folder;
      SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
      dialog.SetFolder(folder);
    } catch {}
    if (dialog.Show(IntPtr.Zero) != 0) return "";
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
[CockpitFolderPicker]::Pick($env:COCKPIT_PICK_PROMPT, $env:COCKPIT_PICK_HOME)
`

/** Returns the chosen path, "" on cancel; throws ENOENT if the tool is missing. */
type FolderPicker = (prompt: string, home: string) => Promise<string>

// Async on purpose: the dialog stays open while the user browses, and a sync
// exec would freeze the whole server (WS, terminals, every other route) for
// that long. The timeout only reaps a dialog left open and forgotten.
const PICKER_TIMEOUT_MS = 5 * 60 * 1000

// Only the picker's stdout matters; stderr is GTK/Qt warning noise.
const run = (
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      // windowsHide: no stray console flashes up when the server itself has
      // none; the dialog is unaffected (checked on a live Windows desktop).
      { encoding: "utf8", timeout: PICKER_TIMEOUT_MS, env, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
    child.stdin?.end()
  })

// Non-zero exit = user cancelled, so resolve to "" rather than throwing.
// Only a missing binary propagates, which is what lets firstOf fall through.
const cancelToEmpty =
  (picker: FolderPicker): FolderPicker =>
  async (prompt, home) => {
    try {
      return await picker(prompt, home)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e
      return ""
    }
  }

/** Try each picker in turn, moving on only when its tool is not installed. */
const firstOf =
  (...pickers: FolderPicker[]): FolderPicker =>
  async (prompt, home) => {
    for (const picker of pickers) {
      try {
        return await picker(prompt, home)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
    }
    return ""
  }

const macPicker: FolderPicker = (prompt, home) =>
  run("osascript", ["-l", "JavaScript", "-e", MAC_PICKER_JXA, prompt, home])

const winPicker: FolderPicker = (prompt, home) =>
  run(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-EncodedCommand",
      Buffer.from(WIN_PICKER_PS, "utf16le").toString("base64"),
    ],
    { ...process.env, COCKPIT_PICK_PROMPT: prompt, COCKPIT_PICK_HOME: home }
  )

const zenityPicker: FolderPicker = (prompt, home) =>
  run("zenity", [
    "--file-selection",
    "--directory",
    `--title=${prompt}`,
    `--filename=${home}/`,
  ])

const kdialogPicker: FolderPicker = (prompt, home) =>
  run("kdialog", ["--getexistingdirectory", home, "--title", prompt])

const pickers: Partial<Record<NodeJS.Platform, FolderPicker>> = {
  darwin: cancelToEmpty(macPicker),
  win32: cancelToEmpty(winPicker),
  linux: firstOf(cancelToEmpty(zenityPicker), cancelToEmpty(kdialogPicker)),
}

const pickFolder: FolderPicker = (prompt, home) =>
  (pickers[process.platform] ?? pickers.linux!)(prompt, home)

export const GET = handler(() =>
  Effect.gen(function* () {
    // Read settings (fall back to "en" on failure)
    const settings = yield* Effect.tryPromise({
      try: () => readJsonFile<{ language?: string }>(SETTINGS_FILE, {}),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ({} as { language?: string })))

    const locale =
      settings.language === "en" || settings.language === "zh"
        ? settings.language
        : "en"
    const prompt = locales[locale].api.pickFolderPrompt
    const home = homedir()

    // Dialog failure or user cancellation -> folder = null
    const result = yield* Effect.tryPromise({
      try: () => pickFolder(prompt, home),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))

    const folder = result ? result.replace(/[/\\]$/, "") : null
    return ok({ folder })
  })
)
