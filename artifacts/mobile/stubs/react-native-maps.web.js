// Web stub for react-native-maps — the real map is replaced by DemoMapBackground on web
import React from 'react';
import { View } from 'react-native';

const MapView = React.forwardRef(function MapView({ children, style }, ref) {
  return React.createElement(View, { style }, children);
});

export const Marker = () => null;
export const Polyline = () => null;
export const Circle = () => null;
export const Polygon = () => null;
export const Callout = () => null;
export const UrlTile = () => null;
export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_DEFAULT = null;

export default MapView;
