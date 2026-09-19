import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import type { JSX } from "solid-js"
import {
  Toast,
  showToast as showLegacyToast,
  toaster as legacyToaster,
  type ToastOptions,
  type ToastVariant,
} from "@opencode-ai/ui/toast"
import { ToastV2, showToastV2, toasterV2 } from "@opencode-ai/ui/v2/toast-v2"

let v2 = false

export function setV2Toast(value: boolean) {
  v2 = value
}

export function ToastRegion(props: { v2: boolean }) {
  if (props.v2) return <ToastV2.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  if (!v2) return showLegacyToast(options)
  if (typeof options === "string") return showToastV2(options)

  return showToastV2({
    ...options,
    icon: resolveIcon(options.icon, options.variant),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

// v1 and v2 ids come from separate registries, so dismissal has to use the same
// implementation that issued the id.
export function dismissToast(toastId: number) {
  if (!v2) return legacyToaster.dismiss(toastId)
  return toasterV2.dismiss(toastId)
}

/**
 * Resolves the v2 toast icon lazily.
 *
 * `showToast` runs from async flows — promises, event handlers, effects that
 * already completed — so there is no owner to create a component under.
 * Building `<Icon/>` here would run its `onMount` as a computation no root
 * owns: the development build reports "computations created outside a
 * `createRoot`" and Solid never disposes it. Returning a factory defers the
 * element until the toast renders it inside its own reactive scope.
 */
export function resolveIcon(
  icon: IconProps["name"] | undefined,
  variant: ToastVariant | undefined,
): (() => JSX.Element) | undefined {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  return () => <Icon name={name} />
}
