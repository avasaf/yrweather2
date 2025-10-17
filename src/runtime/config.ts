import { type ImmutableObject } from 'jimu-core'

export interface Config {
  sourceUrl: string
  userAgent?: string
  autoRefreshEnabled: boolean
  refreshInterval: number
  svgCode: string

  overallBackground: string
  padding: number

  // Text
  mainTextColor: string
  secondaryTextColor: string

  // Grid
  gridLineColor: string
  gridLineWidth: number
  gridLineOpacity: number
  dayBoundaryColor: string
  dayBoundaryWidth: number
  dayBoundaryOpacity: number

  // Curves / bars
  temperatureLineColor: string
  windLineColor: string
  windGustLineColor: string
  precipitationBarColor: string

  // UI buttons
  refreshButtonBackgroundColor: string
  refreshButtonIconColor: string
  expandButtonBackgroundColor: string
  expandButtonIconColor: string
  expandButtonBorderRadius: number

  // Popup
  popupBackgroundColor: string
  popupPadding: number
  popupBorderRadius: number
  popupBoxShadowOffsetX: number
  popupBoxShadowOffsetY: number
  popupBoxShadowBlur: number
  popupBoxShadowSpread: number
  popupBoxShadowColor: string
  blockPage: boolean
  maskColor: string
}

export type IMConfig = ImmutableObject<Config>
