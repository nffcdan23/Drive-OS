import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOCK_VEHICLES, MOCK_JOURNEYS, MOCK_ACHIEVEMENTS } from '@/constants/mockData';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Vehicle {
  id: string;
  nickname: string;
  registration: string;
  make: string;
  model: string;
  year: number;
  colour: string;
  fuelType: 'petrol' | 'diesel' | 'electric' | 'hybrid';
  engine: string;
  power: string;
  torque: string;
  zeroToSixty: string;
  topSpeed: string;
  mileage: number;
  fuelPercentage: number;
  imageUri: string | null;
  isActive: boolean;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface Journey {
  id: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number; // seconds
  distance: number; // km
  averageSpeed: number; // km/h
  topSpeed: number; // km/h
  vehicleId: string;
  notes: string;
  routeCoordinates: Coordinate[];
  photos: string[];
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlockedAt: string | null;
}

export interface UserProfile {
  name: string;
  level: number;
  xp: number;
  xpToNextLevel: number;
  totalDistance: number;
  totalJourneys: number;
  achievements: Achievement[];
}

export interface Friend {
  id: string;
  name: string;
  initials: string;
  status: 'online' | 'offline' | 'driving';
  location: string;
}

export interface Convoy {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
  destination: string;
  driverCount: number;
  isPrivate: boolean;
  startTime: string;
  status: 'forming' | 'active' | 'completed';
  description: string;
}

export interface Destination {
  id: string;
  name: string;
  address: string;
  type: 'home' | 'work' | 'favourite' | 'recent' | 'scenic' | 'search';
  coordinate: Coordinate;
}

export interface ActiveDrive {
  startTime: number; // timestamp ms
  coordinates: Coordinate[];
  speedSamples: number[];
  topSpeed: number;
  estimatedDistance: number;
  currentSpeed: number;
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface AppContextValue {
  vehicles: Vehicle[];
  journeys: Journey[];
  userProfile: UserProfile;
  isPassengerMode: boolean;
  isDriving: boolean;
  currentDrive: ActiveDrive | null;

  activeVehicle: Vehicle | null;
  setActiveVehicle: (id: string) => void;

  addVehicle: (v: Omit<Vehicle, 'id'>) => void;
  updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
  deleteVehicle: (id: string) => void;

  addJourney: (j: Omit<Journey, 'id'>) => void;
  updateJourney: (id: string, updates: Partial<Journey>) => void;
  deleteJourney: (id: string) => void;

  startDrive: () => void;
  updateDriveCoordinate: (coord: Coordinate & { speed: number }) => void;
  endDrive: () => Journey | null;

  togglePassengerMode: () => void;
  updateProfile: (updates: Partial<UserProfile>) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const STORAGE_KEYS = {
  VEHICLES: '@driveos/vehicles',
  JOURNEYS: '@driveos/journeys',
  PROFILE: '@driveos/profile',
  PASSENGER_MODE: '@driveos/passengerMode',
};

const DEFAULT_PROFILE: UserProfile = {
  name: 'Daniel',
  level: 12,
  xp: 3250,
  xpToNextLevel: 5000,
  totalDistance: 4821,
  totalJourneys: 47,
  achievements: MOCK_ACHIEVEMENTS,
};

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>(MOCK_VEHICLES);
  const [journeys, setJourneys] = useState<Journey[]>(MOCK_JOURNEYS);
  const [userProfile, setUserProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [isPassengerMode, setIsPassengerMode] = useState(false);
  const [isDriving, setIsDriving] = useState(false);
  const [currentDrive, setCurrentDrive] = useState<ActiveDrive | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load persisted data
  useEffect(() => {
    const load = async () => {
      try {
        const [vJson, jJson, pJson, pmJson] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.VEHICLES),
          AsyncStorage.getItem(STORAGE_KEYS.JOURNEYS),
          AsyncStorage.getItem(STORAGE_KEYS.PROFILE),
          AsyncStorage.getItem(STORAGE_KEYS.PASSENGER_MODE),
        ]);
        if (vJson) setVehicles(JSON.parse(vJson));
        if (jJson) setJourneys(JSON.parse(jJson));
        if (pJson) setUserProfile(JSON.parse(pJson));
        if (pmJson) setIsPassengerMode(JSON.parse(pmJson));
      } catch (e) {
        // Use defaults on load failure
      } finally {
        setLoaded(true);
      }
    };
    load();
  }, []);

  // Persist vehicles
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEYS.VEHICLES, JSON.stringify(vehicles));
  }, [vehicles, loaded]);

  // Persist journeys
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEYS.JOURNEYS, JSON.stringify(journeys));
  }, [journeys, loaded]);

  // Persist profile
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(userProfile));
  }, [userProfile, loaded]);

  // Persist passenger mode
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEYS.PASSENGER_MODE, JSON.stringify(isPassengerMode));
  }, [isPassengerMode, loaded]);

  const activeVehicle = vehicles.find((v) => v.isActive) ?? vehicles[0] ?? null;

  const setActiveVehicle = useCallback((id: string) => {
    setVehicles((prev) => prev.map((v) => ({ ...v, isActive: v.id === id })));
  }, []);

  const addVehicle = useCallback((v: Omit<Vehicle, 'id'>) => {
    const newV: Vehicle = { ...v, id: generateId() };
    setVehicles((prev) => [...prev, newV]);
  }, []);

  const updateVehicle = useCallback((id: string, updates: Partial<Vehicle>) => {
    setVehicles((prev) => prev.map((v) => (v.id === id ? { ...v, ...updates } : v)));
  }, []);

  const deleteVehicle = useCallback((id: string) => {
    setVehicles((prev) => {
      const filtered = prev.filter((v) => v.id !== id);
      // If deleted vehicle was active, make first remaining vehicle active
      if (filtered.length > 0 && !filtered.some((v) => v.isActive)) {
        filtered[0].isActive = true;
      }
      return filtered;
    });
  }, []);

  const addJourney = useCallback((j: Omit<Journey, 'id'>) => {
    const newJ: Journey = { ...j, id: generateId() };
    setJourneys((prev) => [newJ, ...prev]);
    setUserProfile((prev) => ({
      ...prev,
      totalJourneys: prev.totalJourneys + 1,
      totalDistance: Math.round((prev.totalDistance + j.distance) * 10) / 10,
      xp: prev.xp + Math.round(j.distance * 2),
    }));
  }, []);

  const updateJourney = useCallback((id: string, updates: Partial<Journey>) => {
    setJourneys((prev) => prev.map((j) => (j.id === id ? { ...j, ...updates } : j)));
  }, []);

  const deleteJourney = useCallback((id: string) => {
    setJourneys((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const startDrive = useCallback(() => {
    if (isDriving) return;
    setCurrentDrive({
      startTime: Date.now(),
      coordinates: [],
      speedSamples: [],
      topSpeed: 0,
      estimatedDistance: 0,
      currentSpeed: 0,
    });
    setIsDriving(true);
  }, [isDriving]);

  const updateDriveCoordinate = useCallback((data: Coordinate & { speed: number }) => {
    if (!isDriving || isPassengerMode) return;
    const speedKmh = data.speed * 3.6;
    setCurrentDrive((prev) => {
      if (!prev) return prev;
      const newCoords = [...prev.coordinates, { latitude: data.latitude, longitude: data.longitude }];
      // Estimate distance from last coordinate
      let addedDistance = 0;
      if (prev.coordinates.length > 0) {
        const last = prev.coordinates[prev.coordinates.length - 1];
        const dLat = (data.latitude - last.latitude) * 111;
        const dLon = (data.longitude - last.longitude) * 111 * Math.cos(data.latitude * (Math.PI / 180));
        addedDistance = Math.sqrt(dLat * dLat + dLon * dLon);
      }
      return {
        ...prev,
        coordinates: newCoords,
        speedSamples: [...prev.speedSamples, speedKmh],
        topSpeed: Math.max(prev.topSpeed, speedKmh),
        estimatedDistance: prev.estimatedDistance + addedDistance,
        currentSpeed: speedKmh,
      };
    });
  }, [isDriving, isPassengerMode]);

  const endDrive = useCallback((): Journey | null => {
    if (!isDriving || !currentDrive) return null;
    const endTime = Date.now();
    const durationSec = Math.round((endTime - currentDrive.startTime) / 1000);
    const avgSpeed = currentDrive.speedSamples.length > 0
      ? Math.round(currentDrive.speedSamples.reduce((a, b) => a + b, 0) / currentDrive.speedSamples.length)
      : 0;
    const now = new Date();
    const journeyData: Omit<Journey, 'id'> = {
      name: 'Unnamed Journey',
      date: now.toISOString().split('T')[0],
      startTime: new Date(currentDrive.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      endTime: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      duration: durationSec,
      distance: Math.round(currentDrive.estimatedDistance * 10) / 10,
      averageSpeed: avgSpeed,
      topSpeed: Math.round(currentDrive.topSpeed),
      vehicleId: activeVehicle?.id ?? '',
      notes: '',
      routeCoordinates: currentDrive.coordinates,
      photos: [],
    };
    const newId = generateId();
    const newJourney: Journey = { ...journeyData, id: newId };
    setJourneys((prev) => [newJourney, ...prev]);
    setUserProfile((prev) => ({
      ...prev,
      totalJourneys: prev.totalJourneys + 1,
      totalDistance: Math.round((prev.totalDistance + newJourney.distance) * 10) / 10,
      xp: prev.xp + Math.round(newJourney.distance * 2),
    }));
    setIsDriving(false);
    setCurrentDrive(null);
    return newJourney;
  }, [isDriving, currentDrive, activeVehicle]);

  const togglePassengerMode = useCallback(() => {
    setIsPassengerMode((prev) => !prev);
  }, []);

  const updateProfile = useCallback((updates: Partial<UserProfile>) => {
    setUserProfile((prev) => ({ ...prev, ...updates }));
  }, []);

  const value: AppContextValue = {
    vehicles, journeys, userProfile, isPassengerMode, isDriving, currentDrive,
    activeVehicle, setActiveVehicle,
    addVehicle, updateVehicle, deleteVehicle,
    addJourney, updateJourney, deleteJourney,
    startDrive, updateDriveCoordinate, endDrive,
    togglePassengerMode, updateProfile,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
