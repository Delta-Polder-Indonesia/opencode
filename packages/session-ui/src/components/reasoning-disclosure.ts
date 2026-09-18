import { createEffect, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export function createReasoningDisclosure(streaming: Accessor<boolean>) {
  const [state, setState] = createStore({ open: false })
  // Text updates and manual toggles must not reset the user's choice.
  createEffect(() => {
    if (!streaming()) setState("open", false)
  })
  return { open: () => state.open, setOpen: (open: boolean) => setState("open", open) }
}
