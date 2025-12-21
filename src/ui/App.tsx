import { useState } from "react";
import { Settings } from "lucide-react";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import logo from "./assets/logo.svg";
import "./App.css";

function App() {
  const [networkLan, setNetworkLan] = useState("192.168.178.1");
  const [networkPort, setNetworkPort] = useState("8000");
  const [engineAtem, setEngineAtem] = useState("ATEM 192.168.1.1");
  const [enginePort, setEnginePort] = useState("9091");
  const [outputUsk, setOutputUsk] = useState("HDMI Decklink Card");
  const [outputDsk, setOutputDsk] = useState("SDI");

  return (
    <div className="min-h-screen w-full bg-gradient-to-tr from-background to-accent/50 flex items-center justify-center p-8">
      <div className="w-full max-w-4xl">
        {/* Main Container with Frosted Effect */}
        <div className="p-8 space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <button className="text-card-foreground hover:text-card-foreground/80 transition-colors">
              <Settings className="w-6 h-6" />
            </button>
            <div className="flex-1 flex justify-center">
              <img src={logo} alt="broadify" className="h-12" />
            </div>
            <div className="w-6" /> {/* Spacer for centering */}
          </div>

          {/* Network Section */}
          <Card variant="frosted" className="p-6" gradient>
            <div className="flex items-center gap-6 flex-wrap">
              <h2 className="text-card-foreground font-bold text-lg min-w-[100px]">
                Network
              </h2>
              <div className="flex items-center gap-3">
                <label className="text-card-foreground text-sm font-semibold">
                  LAN
                </label>
                <Select value={networkLan} onValueChange={setNetworkLan}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="192.168.178.1">192.168.178.1</SelectItem>
                    <SelectItem value="192.168.1.1">192.168.1.1</SelectItem>
                    <SelectItem value="192.168.0.1">192.168.0.1</SelectItem>
                    <SelectItem value="10.0.0.1">10.0.0.1</SelectItem>
                    <SelectItem value="172.16.0.1">172.16.0.1</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-card-foreground text-sm font-semibold">
                  Port
                </label>
                <Select value={networkPort} onValueChange={setNetworkPort}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="8000">8000</SelectItem>
                    <SelectItem value="8080">8080</SelectItem>
                    <SelectItem value="3000">3000</SelectItem>
                    <SelectItem value="5000">5000</SelectItem>
                    <SelectItem value="9000">9000</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>

          {/* Engine Section */}
          <Card variant="frosted" className="p-6" gradient>
            <div className="flex items-center gap-6 flex-wrap">
              <h2 className="text-card-foreground font-bold text-lg min-w-[100px]">
                Engine
              </h2>
              <div className="flex items-center gap-3">
                <Select value={engineAtem} onValueChange={setEngineAtem}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ATEM 192.168.1.1">
                      ATEM 192.168.1.1
                    </SelectItem>
                    <SelectItem value="ATEM 192.168.1.2">
                      ATEM 192.168.1.2
                    </SelectItem>
                    <SelectItem value="ATEM 192.168.1.10">
                      ATEM 192.168.1.10
                    </SelectItem>
                    <SelectItem value="ATEM 10.0.0.1">ATEM 10.0.0.1</SelectItem>
                    <SelectItem value="ATEM 172.16.0.1">
                      ATEM 172.16.0.1
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-card-foreground text-sm font-semibold">
                  Port
                </label>
                <Select value={enginePort} onValueChange={setEnginePort}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="9091">9091</SelectItem>
                    <SelectItem value="9910">9910</SelectItem>
                    <SelectItem value="8080">8080</SelectItem>
                    <SelectItem value="8000">8000</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>

          {/* Outputs Section */}
          <Card variant="frosted" className="p-6" gradient>
            <div className="space-y-4">
              <div className="flex items-center gap-6 flex-wrap">
                <h2 className="text-card-foreground font-bold text-lg min-w-[100px]">
                  Outputs
                </h2>
                <div className="flex items-center gap-3">
                  <label className="text-card-foreground text-sm font-semibold">
                    USK
                  </label>
                  <Select value={outputUsk} onValueChange={setOutputUsk}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HDMI Decklink Card">
                        HDMI Decklink Card
                      </SelectItem>
                      <SelectItem value="SDI Decklink Card">
                        SDI Decklink Card
                      </SelectItem>
                      <SelectItem value="USB Capture">USB Capture</SelectItem>
                      <SelectItem value="Blackmagic DeckLink 4K">
                        Blackmagic DeckLink 4K
                      </SelectItem>
                      <SelectItem value="Blackmagic DeckLink 8K">
                        Blackmagic DeckLink 8K
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-6 flex-wrap">
                <div className="min-w-[100px]" /> {/* Spacer */}
                <div className="flex items-center gap-3">
                  <label className="text-card-foreground text-sm font-semibold">
                    DSK
                  </label>
                  <Select value={outputDsk} onValueChange={setOutputDsk}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SDI">SDI</SelectItem>
                      <SelectItem value="HDMI">HDMI</SelectItem>
                      <SelectItem value="USB">USB</SelectItem>
                      <SelectItem value="DisplayPort">DisplayPort</SelectItem>
                      <SelectItem value="Thunderbolt">Thunderbolt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </Card>

          {/* Lets Go Button */}
          <Card variant="frosted" className="p-6" gradient>
            <div className="flex justify-center">
              <Button
                className="bg-primary/90 hover:bg-primary text-primary-foreground font-bold px-12 py-6 text-lg rounded-lg border border-primary/20 shadow-lg"
                onClick={() => {
                  console.log("Lets Go!", {
                    network: { lan: networkLan, port: networkPort },
                    engine: { atem: engineAtem, port: enginePort },
                    outputs: { usk: outputUsk, dsk: outputDsk },
                  });
                }}
              >
                Lets Go!
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default App;
