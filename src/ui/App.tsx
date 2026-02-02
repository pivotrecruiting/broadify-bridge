import { useEffect, useState } from "react";
import { useNetworkConfig } from "./hooks/use-network-config";
import { useBridgeStatus } from "./hooks/use-bridge-status";
import { usePortAvailability } from "./hooks/use-port-availability";
import { useNetworkBinding } from "./hooks/use-network-binding";
import { Header } from "./components/Header";
import { LogsDialog } from "./components/LogsDialog";
import { NetworkSection } from "./components/NetworkSection";
import { BridgeControlButton } from "./components/BridgeControlButton";
import { BridgeIdentitySection } from "./components/BridgeIdentitySection";
import { BridgeNameDialog } from "./components/BridgeNameDialog";
import { calculatePortToUse, shouldUseCustomPort } from "./utils/port-utils";
import "./styles/App.css";

function App() {
  // Network configuration hook
  const {
    networkConfig,
    networkBindingOptions,
    networkBindingId,
    setNetworkBindingId,
    networkPort,
    setNetworkPort,
    customPort,
    setCustomPort,
    showAdvanced,
    setShowAdvanced,
  } = useNetworkConfig();

  // Bridge status hook
  const bridgeStatus = useBridgeStatus();

  // Port availability hook
  const { portAvailability, checkingPorts } = usePortAvailability({
    networkBindingId,
    networkPort,
    customPort,
    showAdvanced,
    bridgeStatus,
    networkConfig,
    networkBindingOptions,
  });

  // Network binding hook
  const { handleBindingChange, getCurrentBindAddress, getCurrentPortConfig } =
    useNetworkBinding({
      networkConfig,
      networkBindingOptions,
      networkBindingId,
      setNetworkBindingId,
      networkPort,
      setNetworkPort,
      customPort,
      setCustomPort,
      showAdvanced,
      setShowAdvanced,
    });

  // Bridge control state
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [bridgeProfile, setBridgeProfile] = useState<{
    bridgeId: string;
    bridgeName: string | null;
  } | null>(null);
  const [showNameDialog, setShowNameDialog] = useState(false);

  // Load bridge profile (name + id) on startup
  useEffect(() => {
    if (!window.electron) return;
    window.electron
      .appGetVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(null));
    window.electron.bridgeGetProfile().then((profile) => {
      setBridgeProfile(profile);
      if (!profile.bridgeName) {
        setShowNameDialog(true);
      }
    });
  }, []);

  const handleSaveBridgeName = async (name: string) => {
    if (!window.electron) {
      return { success: false, error: "Electron API not available" };
    }
    const result = await window.electron.bridgeSetName(name);
    if (result.success) {
      const profile = await window.electron.bridgeGetProfile();
      setBridgeProfile(profile);
      setShowNameDialog(false);
    }
    return result;
  };

  const handleLetsGo = async () => {
    if (!window.electron || !networkConfig) return;
    if (!bridgeProfile?.bridgeName) {
      setShowNameDialog(true);
      alert("Bitte zuerst einen Bridge-Namen setzen.");
      return;
    }

    const portConfig = getCurrentPortConfig();
    const portToUse = calculatePortToUse(
      portConfig,
      showAdvanced,
      customPort,
      networkPort,
      networkConfig
    );

    if (portToUse === null) {
      const useCustomPort = shouldUseCustomPort(
        portConfig,
        showAdvanced,
        customPort
      );
      if (useCustomPort) {
        alert("Bitte geben Sie einen Port ein.");
      } else {
        alert("Bitte wählen Sie einen Port aus.");
      }
      return;
    }

    const bindAddress = getCurrentBindAddress();

    setIsStarting(true);
    try {
      const result = await window.electron.bridgeStart({
        host: bindAddress,
        port: portToUse,
        networkBindingId,
      });

      if (!result.success) {
        console.error("Failed to start bridge:", result.error);
        alert(`Failed to start bridge: ${result.error || "Unknown error"}`);
      } else {
        // If port was changed automatically, update UI
        if (result.actualPort && result.actualPort !== portToUse) {
          const portConfig = getCurrentPortConfig();
          const useCustomPort = shouldUseCustomPort(
            portConfig,
            showAdvanced,
            customPort
          );
          if (useCustomPort) {
            setCustomPort(result.actualPort.toString());
          } else {
            setNetworkPort(result.actualPort.toString());
          }
          alert(
            `Port ${portToUse} was not available. Bridge started on port ${result.actualPort} instead.`
          );
        }
        console.log("Lets Go!", {
          network: {
            binding: networkBindingId,
            bindAddress,
            port: result.actualPort || portToUse,
          },
        });
      }
    } catch (error) {
      console.error("Error starting bridge:", error);
      alert(
        `Error starting bridge: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopServer = async () => {
    if (!window.electron) return;

    setIsStopping(true);
    try {
      const result = await window.electron.bridgeStop();

      if (!result.success) {
        console.error("Failed to stop bridge:", result.error);
        alert(`Failed to stop bridge: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Error stopping bridge:", error);
      alert(
        `Error stopping bridge: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setIsStopping(false);
    }
  };

  // Check if start button should be disabled
  // Note: Outputs are no longer required to start the bridge
  // Bridge starts in "idle" mode and outputs can be configured later via POST /config
  const isStartDisabled = () => {
    if (isStarting) return true;
    const hasBridgeName = Boolean(bridgeProfile?.bridgeName);

    // Check port configuration
    const portConfig = getCurrentPortConfig();
    const useCustomPort = shouldUseCustomPort(
      portConfig,
      showAdvanced,
      customPort
    );
    const portValid = useCustomPort
      ? customPort && customPort.trim() !== ""
      : networkPort && networkPort.trim() !== "";

    // Only port validation is required - outputs are optional
    return !portValid || !hasBridgeName;
  };

  const bridgeName = bridgeProfile?.bridgeName || bridgeStatus.bridgeName || null;
  const bridgeId = bridgeProfile?.bridgeId || bridgeStatus.bridgeId;

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden w-full bg-gradient-to-tr from-background to-accent/50 flex items-center justify-center p-4 sm:p-6 md:p-8">
      <div className="w-full max-w-4xl md:h-auto flex items-center justify-center md:overflow-visible">
        <div className="p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-5 md:space-y-6 w-full">
          <Header
            bridgeStatus={bridgeStatus}
            onOpenDiagnostics={() => setShowLogs(true)}
          />

          <BridgeIdentitySection
            bridgeId={bridgeId}
            bridgeName={bridgeName}
            appVersion={appVersion || undefined}
            pairingCode={bridgeStatus.pairingCode}
            pairingExpiresAt={bridgeStatus.pairingExpiresAt}
            pairingExpired={bridgeStatus.pairingExpired}
            isRunning={bridgeStatus.running}
          />

          <NetworkSection
            networkConfig={networkConfig}
            networkBindingOptions={networkBindingOptions}
            networkBindingId={networkBindingId}
            networkPort={networkPort}
            customPort={customPort}
            showAdvanced={showAdvanced}
            portAvailability={portAvailability}
            checkingPorts={checkingPorts}
            bridgeStatus={bridgeStatus}
            onBindingChange={handleBindingChange}
            onPortChange={setNetworkPort}
            onCustomPortChange={setCustomPort}
            onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
            getCurrentPortConfig={getCurrentPortConfig}
          />

          <BridgeControlButton
            bridgeStatus={bridgeStatus}
            isStarting={isStarting}
            isStopping={isStopping}
            onStart={handleLetsGo}
            onStop={handleStopServer}
            disabled={isStartDisabled()}
          />
        </div>
      </div>
      <LogsDialog isOpen={showLogs} onClose={() => setShowLogs(false)} />
      <BridgeNameDialog
        isOpen={showNameDialog}
        initialName={bridgeName}
        onSave={handleSaveBridgeName}
      />
    </div>
  );
}

export default App;
