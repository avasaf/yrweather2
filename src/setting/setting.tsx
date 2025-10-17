/** @jsx jsx */
import { React, jsx, type AllWidgetSettingProps } from 'jimu-core'
import { NumericInput, TextInput, Switch } from 'jimu-ui'
import { SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { ThemeColorPicker } from 'jimu-ui/basic/color-picker'
import { type IMConfig } from '../runtime/config'
import defaultMessages from './translations/default'

export default class Setting extends React.PureComponent<AllWidgetSettingProps<IMConfig>, unknown> {
  onConfigChange = (key: string, value: any): void => {
    this.props.onSettingChange({
      id: this.props.id,
      config: this.props.config.set(key, value)
    })
  }

  render(): React.ReactElement {
    const { config, intl } = this.props

    const svgCodeBoxStyle = {
      width: '100%',
      minHeight: '100px',
      resize: 'vertical' as const,
      color: '#ffffff',
      backgroundColor: '#282828',
      border: '1px solid #555555',
      borderRadius: '2px',
      padding: '8px',
      fontFamily: 'monospace'
    }

    const horizontalRowStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '12px'
    }

    const labelTextStyle = {
      fontSize: '13px',
      fontWeight: 'normal',
      color: '#adadad',
      whiteSpace: 'nowrap' as const
    }

    const narrowNumericBoxStyle = { width: '60px' }

    return (
      <div className="jimu-widget-setting">
        <SettingSection title={intl.formatMessage({ id: 'dataSource', defaultMessage: defaultMessages.dataSource })}>
          <div style={{ marginBottom: '12px' }}>
            <span style={{ ...labelTextStyle, display: 'block', marginBottom: '4px' }}>
              {intl.formatMessage({ id: 'sourceUrl', defaultMessage: defaultMessages.sourceUrl })}
            </span>
            <TextInput
              value={config.sourceUrl}
              onChange={(e) => { this.onConfigChange('sourceUrl', e.target.value) }}
              placeholder="https://www.yr.no/en/content/.../meteogram.svg"
            />
          </div>

          <div style={horizontalRowStyle}>
            <span style={labelTextStyle}>{intl.formatMessage({ id: 'autoRefresh', defaultMessage: defaultMessages.autoRefresh })}</span>
            <Switch
              checked={config.autoRefreshEnabled}
              onChange={(evt) => { this.onConfigChange('autoRefreshEnabled', evt.target.checked) }}
            />
          </div>

          {config.autoRefreshEnabled && (
            <div style={horizontalRowStyle}>
              <span style={labelTextStyle}>{intl.formatMessage({ id: 'refreshInterval', defaultMessage: defaultMessages.refreshInterval })}</span>
              <NumericInput
                style={narrowNumericBoxStyle}
                value={config.refreshInterval}
                onAcceptValue={(value) => { this.onConfigChange('refreshInterval', value) }}
                min={1}
                step={1}
                size="sm"
                showHandlers={false}
                suffix="min"
              />
            </div>
          )}
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'fallbackContent', defaultMessage: defaultMessages.fallbackContent })}>
          <textarea
            style={svgCodeBoxStyle}
            value={config.svgCode}
            onChange={(e) => { this.onConfigChange('svgCode', e.target.value) }}
            placeholder={intl.formatMessage({ id: 'svgCodePlaceholder', defaultMessage: defaultMessages.svgCodePlaceholder })}
          />
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'generalStyling', defaultMessage: defaultMessages.generalStyling })}>
          <SettingRow label={intl.formatMessage({ id: 'overallBackground', defaultMessage: defaultMessages.overallBackground })}>
            <ThemeColorPicker value={config.overallBackground} onChange={(color) => { this.onConfigChange('overallBackground', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'refreshButtonBackground', defaultMessage: defaultMessages.refreshButtonBackground })}>
            <ThemeColorPicker value={config.refreshButtonBackgroundColor} onChange={(color) => { this.onConfigChange('refreshButtonBackgroundColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'refreshButtonIcon', defaultMessage: defaultMessages.refreshButtonIcon })}>
            <ThemeColorPicker value={config.refreshButtonIconColor} onChange={(color) => { this.onConfigChange('refreshButtonIconColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'padding', defaultMessage: defaultMessages.padding })}>
            <NumericInput
              style={narrowNumericBoxStyle}
              value={config.padding}
              onAcceptValue={(value) => { this.onConfigChange('padding', value) }}
              min={0}
              step={1}
              size="sm"
              showHandlers={false}
              suffix="px"
            />
          </SettingRow>
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'logoStyling', defaultMessage: defaultMessages.logoStyling })}>
          <SettingRow label={intl.formatMessage({ id: 'yrLogoBackgroundColor', defaultMessage: defaultMessages.yrLogoBackgroundColor })}>
            <ThemeColorPicker value={config.yrLogoBackgroundColor} onChange={(color) => { this.onConfigChange('yrLogoBackgroundColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'yrLogoTextColor', defaultMessage: defaultMessages.yrLogoTextColor })}>
            <ThemeColorPicker value={config.yrLogoTextColor} onChange={(color) => { this.onConfigChange('yrLogoTextColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'logoColor', defaultMessage: defaultMessages.logoColor })}>
            <ThemeColorPicker value={config.logoColor} onChange={(color) => { this.onConfigChange('logoColor', color) }} />
          </SettingRow>
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'textStyling', defaultMessage: defaultMessages.textStyling })}>
          <SettingRow label={intl.formatMessage({ id: 'mainTextColor', defaultMessage: defaultMessages.mainTextColor })}>
            <ThemeColorPicker value={config.mainTextColor} onChange={(color) => { this.onConfigChange('mainTextColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'secondaryTextColor', defaultMessage: defaultMessages.secondaryTextColor })}>
            <ThemeColorPicker value={config.secondaryTextColor} onChange={(color) => { this.onConfigChange('secondaryTextColor', color) }} />
          </SettingRow>
          <SettingRow label="Axis Icons">
            <ThemeColorPicker value={config.yAxisIconColor} onChange={(color) => { this.onConfigChange('yAxisIconColor', color) }} />
          </SettingRow>
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'graphStyling', defaultMessage: defaultMessages.graphStyling })}>
          <SettingRow label={intl.formatMessage({ id: 'gridLineColor', defaultMessage: defaultMessages.gridLineColor })}>
            <ThemeColorPicker value={config.gridLineColor} onChange={(color) => { this.onConfigChange('gridLineColor', color) }} />
          </SettingRow>
          <div style={horizontalRowStyle}>
            <span style={labelTextStyle}>{intl.formatMessage({ id: 'gridLineWidth', defaultMessage: defaultMessages.gridLineWidth })}</span>
            <NumericInput style={narrowNumericBoxStyle} value={config.gridLineWidth} onAcceptValue={(value) => { this.onConfigChange('gridLineWidth', value) }} min={0.5} step={0.5} showHandlers={false} size="sm" suffix="px" />
          </div>
          <div style={horizontalRowStyle}>
            <span style={labelTextStyle}>{intl.formatMessage({ id: 'gridLineOpacity', defaultMessage: defaultMessages.gridLineOpacity })}</span>
            <NumericInput style={narrowNumericBoxStyle} value={config.gridLineOpacity * 100} onAcceptValue={(value) => { this.onConfigChange('gridLineOpacity', value / 100) }} min={0} max={100} step={5} showHandlers={false} size="sm" suffix="%" />
          </div>

          <SettingRow label={intl.formatMessage({ id: 'temperatureLineColor', defaultMessage: defaultMessages.temperatureLineColor })}>
            <ThemeColorPicker value={config.temperatureLineColor} onChange={(color) => { this.onConfigChange('temperatureLineColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'windLineColor', defaultMessage: defaultMessages.windLineColor })}>
            <ThemeColorPicker value={config.windLineColor} onChange={(color) => { this.onConfigChange('windLineColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'windGustLineColor', defaultMessage: defaultMessages.windGustLineColor })}>
            <ThemeColorPicker value={config.windGustLineColor} onChange={(color) => { this.onConfigChange('windGustLineColor', color) }} />
          </SettingRow>

          <SettingRow label={intl.formatMessage({ id: 'precipitationBarColor', defaultMessage: defaultMessages.precipitationBarColor })}>
            <ThemeColorPicker value={config.precipitationBarColor} onChange={(color) => { this.onConfigChange('precipitationBarColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'maxPrecipitationColor', defaultMessage: defaultMessages.maxPrecipitationColor })}>
            <ThemeColorPicker value={config.maxPrecipitationColor} onChange={(color) => { this.onConfigChange('maxPrecipitationColor', color) }} />
          </SettingRow>
        </SettingSection>

        <SettingSection title={intl.formatMessage({ id: 'expandPopupStyling', defaultMessage: defaultMessages.expandPopupStyling })}>
          <SettingRow label={intl.formatMessage({ id: 'expandButtonBackground', defaultMessage: defaultMessages.expandButtonBackground })}>
            <ThemeColorPicker value={config.expandButtonBackgroundColor} onChange={(color) => { this.onConfigChange('expandButtonBackgroundColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'expandButtonIcon', defaultMessage: defaultMessages.expandButtonIcon })}>
            <ThemeColorPicker value={config.expandButtonIconColor} onChange={(color) => { this.onConfigChange('expandButtonIconColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'expandButtonBorderRadius', defaultMessage: defaultMessages.expandButtonBorderRadius })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.expandButtonBorderRadius} onAcceptValue={(value) => { this.onConfigChange('expandButtonBorderRadius', value) }} min={0} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBackground', defaultMessage: defaultMessages.popupBackground })}>
            <ThemeColorPicker value={config.popupBackgroundColor} onChange={(color) => { this.onConfigChange('popupBackgroundColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupPadding', defaultMessage: defaultMessages.popupPadding })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupPadding} onAcceptValue={(value) => { this.onConfigChange('popupPadding', value) }} min={0} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBorderRadius', defaultMessage: defaultMessages.popupBorderRadius })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupBorderRadius} onAcceptValue={(value) => { this.onConfigChange('popupBorderRadius', value) }} min={0} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBoxShadowOffsetX', defaultMessage: defaultMessages.popupBoxShadowOffsetX })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupBoxShadowOffsetX} onAcceptValue={(value) => { this.onConfigChange('popupBoxShadowOffsetX', value) }} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBoxShadowOffsetY', defaultMessage: defaultMessages.popupBoxShadowOffsetY })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupBoxShadowOffsetY} onAcceptValue={(value) => { this.onConfigChange('popupBoxShadowOffsetY', value) }} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBoxShadowBlur', defaultMessage: defaultMessages.popupBoxShadowBlur })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupBoxShadowBlur} onAcceptValue={(value) => { this.onConfigChange('popupBoxShadowBlur', value) }} min={0} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBoxShadowSpread', defaultMessage: defaultMessages.popupBoxShadowSpread })}>
            <NumericInput style={narrowNumericBoxStyle} value={config.popupBoxShadowSpread} onAcceptValue={(value) => { this.onConfigChange('popupBoxShadowSpread', value) }} step={1} showHandlers={false} size="sm" suffix="px" />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'popupBoxShadowColor', defaultMessage: defaultMessages.popupBoxShadowColor })}>
            <ThemeColorPicker value={config.popupBoxShadowColor} onChange={(color) => { this.onConfigChange('popupBoxShadowColor', color) }} />
          </SettingRow>
          <SettingRow label={intl.formatMessage({ id: 'blockPage', defaultMessage: defaultMessages.blockPage })}>
            <Switch checked={config.blockPage} onChange={(evt) => { this.onConfigChange('blockPage', evt.target.checked) }} />
          </SettingRow>
          {config.blockPage && (
            <SettingRow label={intl.formatMessage({ id: 'maskColor', defaultMessage: defaultMessages.maskColor })}>
              <ThemeColorPicker value={config.maskColor} onChange={(color) => { this.onConfigChange('maskColor', color) }} />
            </SettingRow>
          )}
        </SettingSection>
      </div>
    )
  }
}
