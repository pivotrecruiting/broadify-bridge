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
import "./styles/App.css";

function App() {
  const [networkLan, setNetworkLan] = useState("192.168.178.1");
  const [networkPort, setNetworkPort] = useState("8000");
  const [engineAtem, setEngineAtem] = useState("ATEM 192.168.1.1");
  const [enginePort, setEnginePort] = useState("9091");
  const [outputUsk, setOutputUsk] = useState("HDMI Decklink Card");
  const [outputDsk, setOutputDsk] = useState("SDI");

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden w-full bg-gradient-to-tr from-background to-accent/50 flex items-center justify-center p-4 sm:p-6 md:p-8">
      <div className="w-full max-w-4xl md:h-auto flex items-center justify-center md:overflow-visible">
        {/* Main Container with Frosted Effect */}
        <div className="p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-5 md:space-y-6 w-full">
          {/* Header */}
          <div className="flex items-center justify-between mb-2 sm:mb-4 md:mb-8">
            <button className="text-card-foreground hover:text-card-foreground/80 transition-colors">
              <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
            <div className="flex-1 flex justify-center">
              <img src={logo} alt="broadify" className="h-14 sm:h-16 md:h-20" />
            </div>
            <div className="w-5 sm:w-6" /> {/* Spacer for centering */}
          </div>

          {/* Network Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Network
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    LAN
                  </label>
                  <Select value={networkLan} onValueChange={setNetworkLan}>
                    <SelectTrigger className="w-full sm:w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="192.168.178.1">
                        192.168.178.1
                      </SelectItem>
                      <SelectItem value="192.168.1.1">192.168.1.1</SelectItem>
                      <SelectItem value="192.168.0.1">192.168.0.1</SelectItem>
                      <SelectItem value="10.0.0.1">10.0.0.1</SelectItem>
                      <SelectItem value="172.16.0.1">172.16.0.1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    Port
                  </label>
                  <Select value={networkPort} onValueChange={setNetworkPort}>
                    <SelectTrigger className="w-full sm:w-24">
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
            </div>
          </Card>

          {/* Engine Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Engine
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px] opacity-0 pointer-events-none">
                    {/* Invisible label for alignment */}
                  </label>
                  <Select value={engineAtem} onValueChange={setEngineAtem}>
                    <SelectTrigger className="w-full sm:w-48">
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
                      <SelectItem value="ATEM 10.0.0.1">
                        ATEM 10.0.0.1
                      </SelectItem>
                      <SelectItem value="ATEM 172.16.0.1">
                        ATEM 172.16.0.1
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    Port
                  </label>
                  <Select value={enginePort} onValueChange={setEnginePort}>
                    <SelectTrigger className="w-full sm:w-24">
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
            </div>
          </Card>

          {/* Outputs Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Outputs
              </h2>
              <div className="space-y-3 sm:space-y-4">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    USK
                  </label>
                  <Select value={outputUsk} onValueChange={setOutputUsk}>
                    <SelectTrigger className="w-full sm:w-48">
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
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    DSK
                  </label>
                  <Select value={outputDsk} onValueChange={setOutputDsk}>
                    <SelectTrigger className="w-full sm:w-48">
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
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="flex justify-center">
              <Button
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-8 sm:px-24 md:px-32 py-5 sm:py-5 md:py-6 text-base sm:text-lg rounded-lg border border-primary/20 shadow-lg w-full sm:w-auto"
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
