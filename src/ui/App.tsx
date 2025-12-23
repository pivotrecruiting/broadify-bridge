import { useState, useEffect } from "react";
import { useNetworkConfig } from "./hooks/use-network-config";
import { useBridgeStatus } from "./hooks/use-bridge-status";
import { usePortAvailability } from "./hooks/use-port-availability";
import { useNetworkBinding } from "./hooks/use-network-binding";
import { useBridgeOutputs } from "./hooks/use-bridge-outputs";
import { Header } from "./components/Header";
import { NetworkSection } from "./components/NetworkSection";
import { EngineSection } from "./components/EngineSection";
import { OutputsSection } from "./components/OutputsSection";
import { BridgeControlButton } from "./components/BridgeControlButton";
import { calculatePortToUse, shouldUseCustomPort } from "./utils/port-utils";
import {
  ENGINE_ATEM_OPTIONS,
  ENGINE_PORT_OPTIONS,
} from "./constants/engine-constants";
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

  // Bridge outputs hook
  const {
    outputs: bridgeOutputs,
    loading: outputsLoading,
    refetch: refetchOutputs,
  } = useBridgeOutputs();

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

  // Engine state
  const [engineAtem, setEngineAtem] = useState<string>(ENGINE_ATEM_OPTIONS[0]);
  const [enginePort, setEnginePort] = useState<string>(ENGINE_PORT_OPTIONS[0]);

  // Outputs state - initialize with first available output or empty string
  const [output1, setOutput1] = useState<string>("");
  const [output2, setOutput2] = useState<string>("");

  // Update outputs when bridge outputs are loaded
  useEffect(() => {
    if (bridgeOutputs) {
      // Set default to first available output if not set
      if (!output1 && bridgeOutputs.output1.length > 0) {
        const firstAvailable = bridgeOutputs.output1.find(
          (opt) => opt.available
        );
        if (firstAvailable) {
          setOutput1(firstAvailable.id);
        }
      }
      if (!output2 && bridgeOutputs.output2.length > 0) {
        const firstAvailable = bridgeOutputs.output2.find(
          (opt) => opt.available
        );
        if (firstAvailable) {
          setOutput2(firstAvailable.id);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeOutputs]);

  // Refetch outputs when bridge becomes reachable
  useEffect(() => {
    if (bridgeStatus.reachable) {
      refetchOutputs();
    }
  }, [bridgeStatus.reachable, refetchOutputs]);

  // Bridge control state
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const handleLetsGo = async () => {
    if (!window.electron || !networkConfig) return;

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

    // Resolve output IDs to names for bridge config
    const output1Name =
      bridgeOutputs?.output1.find((opt) => opt.id === output1)?.name || output1;
    const output2Name =
      bridgeOutputs?.output2.find((opt) => opt.id === output2)?.name || output2;

    setIsStarting(true);
    try {
      const result = await window.electron.bridgeStart({
        host: bindAddress,
        port: portToUse,
        outputs: {
          output1: output1Name,
          output2: output2Name,
        },
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
          engine: { atem: engineAtem, port: enginePort },
          outputs: { output1: output1, output2: output2 },
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
  const isStartDisabled = () => {
    if (isStarting) return true;

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

    if (!portValid) return true;

    // Check outputs are selected
    if (!output1 || !output2) return true;

    // Check outputs are available
    const output1Valid = bridgeOutputs?.output1.some(
      (opt) => opt.id === output1 && opt.available
    );
    const output2Valid = bridgeOutputs?.output2.some(
      (opt) => opt.id === output2 && opt.available
    );

    return !output1Valid || !output2Valid;
  };

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden w-full bg-gradient-to-tr from-background to-accent/50 flex items-center justify-center p-4 sm:p-6 md:p-8">
      <div className="w-full max-w-4xl md:h-auto flex items-center justify-center md:overflow-visible">
        <div className="p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-5 md:space-y-6 w-full">
          <Header bridgeStatus={bridgeStatus} />

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

          <EngineSection
            engineAtem={engineAtem}
            enginePort={enginePort}
            onAtemChange={setEngineAtem}
            onPortChange={setEnginePort}
          />

          <OutputsSection
            output1={output1}
            output2={output2}
            output1Options={bridgeOutputs?.output1 || []}
            output2Options={bridgeOutputs?.output2 || []}
            loading={outputsLoading}
            onOutput1Change={setOutput1}
            onOutput2Change={setOutput2}
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
    </div>
  );
}

export default App;
