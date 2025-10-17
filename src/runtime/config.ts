import { type ImmutableObject } from 'jimu-core'

export interface Config {
  sourceUrl: string
  autoRefreshEnabled: boolean
  refreshInterval: number
  svgCode: string

  overallBackground: string
  padding: number

  // Logos / text
  logoColor: string
  yrLogoBackgroundColor: string
  yrLogoTextColor: string
  yAxisIconColor: string          // used for BOTH Y and X axis icons
  mainTextColor: string
  secondaryTextColor: string

  // Grid
  gridLineColor: string
  gridLineWidth: number
  gridLineOpacity: number

  // Curves / bars
  temperatureLineColor: string
  windLineColor: string
  windGustLineColor: string
  precipitationBarColor: string
  maxPrecipitationColor: string

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
