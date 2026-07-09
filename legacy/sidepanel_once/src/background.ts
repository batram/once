import * as presenters_backend from "./js/view/presenters_backend"

function iniBackground() {
  presenters_backend.custom_protocol()

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error))
}

iniBackground()
