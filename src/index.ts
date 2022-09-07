import csv from 'csv-parser';
import fs from 'fs';
import moment from 'moment';
import _, { clone, remove } from 'lodash';

type MeterFlow = 'Generation' | 'Consumption';

type Window = {
  consumption: number;
  generation: number;
  batteryCharge: number;
}

type TimeWindows = { [time: string]: Window };

type MeterEntry = {
  date: moment.Moment;
  timeWindows: TimeWindows;
};

function calIndex(data: { hour: number, minute: number }): number {
  return data.hour * 60 + data.minute;
}

const zeroPad = (num: number, places: number) => String(num).padStart(places, '0')

function rawIndex(data: { hour: number, minute: number }): string {
  const { hour, minute } = data;

  const pad2 = (num: number) => zeroPad(num, 2);
  const startHour = pad2(hour,);
  const endHour = pad2(minute > 0 ? (hour === 23 ? 0 : hour + 1) : hour);
  const startMinute = pad2(minute);
  const endMinute = pad2(minute > 0 ? 0 : 30);
  return `${startHour}:${startMinute} - ${endHour}:${endMinute}`
}

function emptyTimeWindows(): TimeWindows {
  const timeWindows: TimeWindows = {};
  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {
      const windowIndex = calIndex({ hour, minute });
      timeWindows[windowIndex] = {
        consumption: 0,
        generation: 0,
        batteryCharge: 0
      };
    }
  }
  return timeWindows;
}

function parseEntry(rawEntry: any): MeterEntry {
  const date = moment(rawEntry['DATE'], 'DD/MM/YYY');
  const flow = rawEntry['CON/GEN'];
  const isGeneration = flow === 'Generation';

  const timeWindows: TimeWindows = emptyTimeWindows();

  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {

      const windowIndex = calIndex({ hour, minute });
      const rawWindowIndex = rawIndex({ hour, minute });
      const increment = parseFloat(rawEntry[rawWindowIndex]);
      //console.log(rawWindowIndex);
      if (isGeneration) {
        timeWindows[windowIndex].generation += increment;
      } else {
        timeWindows[windowIndex].consumption += increment;
      }
    }
  }

  return {
    date,
    timeWindows
  };
}

function mergeMeterEntries(entries: Array<MeterEntry>): Array<MeterEntry> {
  const result = new Array<MeterEntry>();
  const groupedEntries = _.groupBy(entries, entry => entry.date.toISOString());

  for (const groupedDate in groupedEntries) {
    if (Object.prototype.hasOwnProperty.call(groupedEntries, groupedDate)) {
      const sameDayEntries = groupedEntries[groupedDate];

      const reducedResult = sameDayEntries.reduce((prev, curr) => {
        for (let hour = 0; hour < 24; hour++) {
          for(let minute = 0; minute < 60; minute += 30) {
            const windowIndex = calIndex({ hour, minute });
            prev.timeWindows[windowIndex].consumption += curr.timeWindows[windowIndex].consumption;
            prev.timeWindows[windowIndex].generation += curr.timeWindows[windowIndex].generation;
          }
        }

        return prev;
      });

      result.push(reducedResult);
    }
  }

  return result;
}

type SimulationSettings = {
  /**
   * The size, in kWh, of the battery storage solution.
   */
  batterySize: number;
};

type CostSettings = {
  /**
   * The price, in cents, of the feed in tarif for sending solar to the grid.
   */
   feedInTarif: number;

   /**
    * Electricity Prices separated per half hour to allow for time-of-use pricing.
    */
   costPerHour: CostPerHour;
};

type CostPerHour = { [time: string]: number };

type BatteryState = {
  currentCharge: number;
}

function cloneEntry(entry: MeterEntry): MeterEntry {
  return {
    date: moment(entry.date),
    timeWindows: JSON.parse(JSON.stringify(entry.timeWindows))
  };
}

function addGeneration(data: { currentBatteryCharge: number, maxBatterySize: number, generation: number }): { updatedChargePostGen: number, updatedGeneration: number } {
  const {currentBatteryCharge, maxBatterySize, generation} = data;

  const uncharged = maxBatterySize - currentBatteryCharge;
  const chargeToAdd = Math.min(uncharged, generation);

  return {
    updatedChargePostGen: currentBatteryCharge + chargeToAdd,
    updatedGeneration: generation - chargeToAdd
  };
}

function removeConsumption(data: { currentBatteryCharge: number, consumption: number }): { updatedChargePostCons: number, updatedConsumption: number } {
  const { currentBatteryCharge, consumption } = data;

  const chargeToRemove = Math.min(currentBatteryCharge, consumption);

  return {
    updatedChargePostCons: currentBatteryCharge - chargeToRemove,
    updatedConsumption: consumption - chargeToRemove
  }
}

function simulateEntry(entry: MeterEntry, initialBatteryCharge: number, maxBatterySize: number): MeterEntry {
  const result = cloneEntry(entry);

  let currentBatteryCharge = initialBatteryCharge;
  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {
      const windowIndex = calIndex({ hour, minute });

      const window = result.timeWindows[windowIndex];
      const {updatedChargePostGen, updatedGeneration } = addGeneration({ currentBatteryCharge, maxBatterySize, generation: window.generation });
      const { updatedChargePostCons, updatedConsumption } = removeConsumption({ currentBatteryCharge: updatedChargePostGen, consumption: window.consumption });

      currentBatteryCharge = updatedChargePostCons;
      result.timeWindows[windowIndex] = {
        consumption: updatedConsumption,
        generation: updatedGeneration,
        batteryCharge: updatedChargePostCons
      };
    }
  }
  // For each half hour segment
  // Any generation that can be pushed into the battery should be pushed into the battery
  // Any consumption that can be pulled from the battery should be pulled into the battery
  // Leave the remainder in the entry because that will be pushed and pulled into the grid

  return result;
}

function simulateBattery(meterEntries: Array<MeterEntry>, settings: SimulationSettings): Array<MeterEntry> {
  const batteryState: BatteryState = { currentCharge: 0 };

  return meterEntries.map(entry => {
    const newEntry = simulateEntry(entry, batteryState.currentCharge, settings.batterySize);
    batteryState.currentCharge = newEntry.timeWindows[calIndex({ hour: 23, minute: 30 })].batteryCharge;
    return newEntry;
    // For each half hour segment
    // Any generation that can be pushed into the battery should be pushed into the battery
    // Any consumption that can be pulled from the battery should be pulled into the battery
    // Register
  });
}

type SimulationResults = {
  cost: CostResults;

  /**
   * Measured in kWh
   */
  totalBatteryOutput: number;

  /**
   * The count of the number of days in which the battery reached 100% at least once.
   */
  timesReachedFullBatteryAtLeastOnceInTheDay: number;
};

type AggregateResult = {
  consumptionCost: number;
  generationEarnings: number;
}

type CostResults = {
  perMonth: { [month: string]: AggregateResult };
  perYear: { [year: string]: AggregateResult };
};

function aggregateCosts(monthEntries: Array<MeterEntry>, costSettings: CostSettings): AggregateResult {
  let consumptionCost = 0;
  let generationEarnings = 0;

  monthEntries.forEach(entry => {
    for (let hour = 0; hour < 24; hour++) {
      for(let minute = 0; minute < 60; minute += 30) {
        const windowIndex = calIndex({ hour, minute });

        const timeWindow = entry.timeWindows[windowIndex];
        consumptionCost += timeWindow.consumption * costSettings.costPerHour[windowIndex];
        generationEarnings += timeWindow.generation * costSettings.feedInTarif;
      }
    }
  });

  return {
    consumptionCost,
    generationEarnings
  };
}

function calculateStatistics(meterEntries: Array<MeterEntry>, costSettings: CostSettings): SimulationResults {
  const entriesByMonth = _.groupBy(meterEntries, entry => entry.date.format('YYYY-MM'));
  const perMonth = _.mapValues(entriesByMonth, entries => aggregateCosts(entries, costSettings));

  const entriesByYear = _.groupBy(meterEntries, entry => entry.date.format('YYYY'));
  const perYear = _.mapValues(entriesByYear, entries => aggregateCosts(entries, costSettings));

  return {
    cost: {
      perMonth,
      perYear
    },
    totalBatteryOutput: 0,
    timesReachedFullBatteryAtLeastOnceInTheDay: 0
  };
}

function printStatistics(title: string, stats: SimulationResults): void {
  console.log(`## Results: ${title}`);
  console.log('');
  for (const month in stats.cost.perMonth) {
    if (Object.prototype.hasOwnProperty.call(stats.cost.perMonth, month)) {
      const monthCosts = stats.cost.perMonth[month];
      const costInDollars = (monthCosts.consumptionCost - monthCosts.generationEarnings) / 100.0;
      console.log(`${month}: $${costInDollars}`);
    }
  }
  console.log('');
}

function printStatsComparison(title: string, higher: SimulationResults, lower: SimulationResults): void {
  console.log(`## Comparison: ${title}`);
  console.log('');

  console.log('Per Month');
  for (const month in higher.cost.perMonth) {
    if (Object.prototype.hasOwnProperty.call(higher.cost.perMonth, month)) {
      const higherCosts = higher.cost.perMonth[month];
      const lowerCosts = lower.cost.perMonth[month];

      const higherDiff = higherCosts.consumptionCost - higherCosts.generationEarnings;
      const lowerDiff = lowerCosts.consumptionCost - lowerCosts.generationEarnings;
      console.log(`${month}: $${(higherDiff - lowerDiff) / 100.0} savings`);
    }
  }
  console.log('');
  console.log('Per year');
  for (const year in higher.cost.perYear) {
    if (Object.prototype.hasOwnProperty.call(higher.cost.perYear, year)) {
      const higherCosts = higher.cost.perYear[year];
      const lowerCosts = lower.cost.perYear[year];

      const higherDiff = higherCosts.consumptionCost - higherCosts.generationEarnings;
      const lowerDiff = lowerCosts.consumptionCost - lowerCosts.generationEarnings;
      console.log(`${year}: $${(higherDiff - lowerDiff) / 100.0} savings`);
    }
  }
  console.log('');
}

const STANDARD_FEED_IN_TARIF = 4;
const STANDARD_ENERGY_COST = 25.25;

function constantPerHourCost(cost: number): CostPerHour {
  const result: CostPerHour = {};

  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {
      const windowIndex = calIndex({ hour, minute });

      result[windowIndex] = cost;
    }
  }

  return result;
}

const POWERWALL_SIZE = 13.5;

function main() {
  const allEntries: Array<MeterEntry> = [];
  fs.createReadStream('pauls.csv')
  .pipe(csv())
  .on('data', (data) => {
    //console.log(data);
    const entry = parseEntry(data);
    //console.log(entry.date.toString());
    //console.log(JSON.stringify(entry.timeWindows, null, 2));
    allEntries.push(entry);
  })
  .on('end', () => {
    console.log('Finished');
    const rawData = mergeMeterEntries(allEntries);

    const noBatteryResults = simulateBattery(rawData, {
      batterySize: 0
    });
    const oneBatteryResults = simulateBattery(rawData, {
      batterySize: POWERWALL_SIZE * 1
    });
    const twoBatteryResults = simulateBattery(rawData, {
      batterySize: POWERWALL_SIZE * 2
    });

    const noBatteryStatistics = calculateStatistics(noBatteryResults, {
      feedInTarif: STANDARD_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(STANDARD_ENERGY_COST)
    });
    const oneBatteryStatistics = calculateStatistics(oneBatteryResults, {
      feedInTarif: STANDARD_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(STANDARD_ENERGY_COST)
    });
    const twoBatteryStatistics = calculateStatistics(twoBatteryResults, {
      feedInTarif: STANDARD_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(STANDARD_ENERGY_COST)
    });

    printStatistics('No Battery', noBatteryStatistics);
    printStatistics('One Battery', oneBatteryStatistics);
    printStatistics('Two Batteries', twoBatteryStatistics);
    printStatsComparison('No to One Battery', noBatteryStatistics, oneBatteryStatistics);
    printStatsComparison('No to Two Battery', noBatteryStatistics, twoBatteryStatistics);
    printStatsComparison('One to Two Battery', oneBatteryStatistics, twoBatteryStatistics);

    // Scenarios to simulate
    // No battery (current state)
    // 13.5kWh (One powerwall)
    // 27kWh (Two Powerwalls)
    // Then vary with different energy plans, one time of use and one consistent usage.
    // Some plans vary with how much power has been consumed over the month

  });
}

main();