//import * as path from "path"
//import * as fs from "fs"

export declare interface Presenter_Backend {
  custom_protocol?: () => void
  //context_link?: (con_menu: Menu, cmenu_data: CMenuData) => void
}

let presenters: Presenter_Backend[] = []

function get_active(): Presenter_Backend[] {
  if (presenters.length == 0) {
    presenters = []
  }

  return presenters
}
/*
export function context_link(con_menu: Menu, cmenu_data: CMenuData): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "context_link")) {
      presenter["context_link"](con_menu, cmenu_data)
    }
  })
}*/

export function custom_protocol(): void {
  get_active().forEach((presenter) => {
    if (Object.prototype.hasOwnProperty.call(presenter, "custom_protocol")) {
      presenter["custom_protocol"]()
    }
  })
}
