import { OnceClient } from "@once/app"
import {
  parseFilterListsText,
  parseUserscriptsText,
  presentFilterLists,
  presentUserscripts
} from "@once/core"
import { requireElement } from "../dom"
import * as settingsControls from "./settingsControlBindings"
import { trackSettingsSave } from "./settingsStatus"

export interface ExtensionSettingsEditors {
  /** Re-reads both documents into their editors, after a change elsewhere. */
  refresh(): void
}

interface TextDocumentEditor {
  textareaId: string
  present(): Promise<string>
  save(text: string): Promise<void>
}

// Parsing throws on a line that is not a URL or a script without a header;
// the message shows beside the editor and the text stays for the user to fix.
async function saveTextDocument(
  area: HTMLTextAreaElement,
  save: () => Promise<void>
): Promise<void> {
  try {
    await trackSettingsSave(area, save)
  } catch (error) {
    const status = area.closest(".settings_block")?.querySelector(".settings_status")
    const message = error instanceof Error ? error.message : String(error)
    if (status) status.textContent = `Could not save: ${message}`
  }
}

function bindTextDocument(editor: TextDocumentEditor, onChanged: () => void): () => Promise<void> {
  const restore = async (): Promise<void> => {
    requireElement<HTMLTextAreaElement>(`#${editor.textareaId}`).value = await editor.present()
    onChanged()
  }
  void restore()
  settingsControls.bindTextSetting({
    textareaId: editor.textareaId,
    restore,
    save: () => {
      const area = requireElement<HTMLTextAreaElement>(`#${editor.textareaId}`)
      return saveTextDocument(area, () => editor.save(area.value))
    }
  })
  return restore
}

/** The filter-list and userscript editors: plain text in, documents out. */
export function bindExtensionSettingsEditors(
  client: OnceClient,
  onChanged: () => void
): ExtensionSettingsEditors {
  const restoreLists = bindTextDocument({
    textareaId: "filter_lists_area",
    present: async () => presentFilterLists(await client.getFilterLists()),
    save: (text) => client.saveFilterLists(parseFilterListsText(text))
  }, onChanged)
  const restoreScripts = bindTextDocument({
    textareaId: "userscripts_area",
    present: async () => presentUserscripts(await client.getUserscripts()),
    save: (text) => client.saveUserscripts(parseUserscriptsText(text))
  }, onChanged)
  return {
    refresh: () => {
      void restoreLists()
      void restoreScripts()
    }
  }
}
