/**
 * /api/pick-folder
 *
 * Launches the OS-native folder picker dialog. Returns `folder: null` on
 * failure or user cancellation.
 */
import { execSync } from "child_process"
import { homedir } from "os"
import { Effect } from "effect"
import {
  isMac,
  isWindows,
  SETTINGS_FILE,
  readJsonFile,
} from "@cockpit/shared-utils"
import en from "@cockpit/shared-i18n/locales/en.json"
import zh from "@cockpit/shared-i18n/locales/zh.json"
import { handler, ok } from "@cockpit/effect-runtime/server"

const locales: Record<string, typeof en> = { en, zh }

const pickFolder = (prompt: string, home: string): string => {
  if (isMac) {
    const script = `osascript -e 'POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${home}")'`
    return execSync(script, { encoding: "utf8", timeout: 60000 }).trim()
  }
  if (isWindows) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${home}'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`
    return execSync(`powershell -Command "${ps}"`, {
      encoding: "utf8",
      timeout: 60000,
    }).trim()
  }
  // Linux: try zenity, fallback to kdialog
  try {
    return execSync(
      `zenity --file-selection --directory --title="${prompt}" 2>/dev/null`,
      { encoding: "utf8", timeout: 60000 }
    ).trim()
  } catch {
    return execSync(
      `kdialog --getexistingdirectory "${home}" --title "${prompt}" 2>/dev/null`,
      { encoding: "utf8", timeout: 60000 }
    ).trim()
  }
}

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
    const result = yield* Effect.try({
      try: () => pickFolder(prompt, home),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))

    const folder = result ? result.replace(/[/\\]$/, "") : null
    return ok({ folder })
  })
)
