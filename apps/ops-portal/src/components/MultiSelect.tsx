// Folded into the picker family (2026-08-12). This module was the first
// multi-select, built for the Inventory status filter; the review then asked for
// searchable single AND multi variants sharing one implementation, so the real
// component now lives in Picker.tsx and this file only re-exports.
//
// Kept as a re-export rather than deleted so existing imports keep resolving,
// and because `MultiSelectOption` was its public name for what Picker calls
// `PickerOption`.
export { MultiSelect, type MultiSelectProps } from './Picker.js'
export type { PickerOption as MultiSelectOption } from './Picker.js'
