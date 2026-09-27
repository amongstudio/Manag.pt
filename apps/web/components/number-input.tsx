"use client"

import * as React from "react"

import { Input } from "@workspace/ui/components/input"

type NumberInputProps = Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value
  if (min != null && next < min) next = min
  if (max != null && next > max) next = max
  return next
}

/**
 * Controlled numeric input that never commits NaN or a spurious 0.
 * While typing, only valid in-range values are committed; on blur the text
 * snaps back to the last committed value (clamped to min/max).
 */
export function NumberInput({ value, onValueChange, min, max, ...props }: NumberInputProps) {
  const [text, setText] = React.useState(String(value))
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  return (
    <Input
      {...props}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      value={text}
      onFocus={(e) => {
        setFocused(true)
        props.onFocus?.(e)
      }}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        if (raw.trim() === "") return
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        if (min != null && parsed < min) return
        if (max != null && parsed > max) return
        onValueChange(parsed)
      }}
      onBlur={(e) => {
        setFocused(false)
        const parsed = Number(text)
        if (text.trim() === "" || !Number.isFinite(parsed)) {
          setText(String(value))
        } else {
          const next = clamp(parsed, min, max)
          if (next !== value) onValueChange(next)
          setText(String(next))
        }
        props.onBlur?.(e)
      }}
    />
  )
}
