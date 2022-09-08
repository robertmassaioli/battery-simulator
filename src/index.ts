import csv from 'csv-parser';
import fs from 'fs';
import moment from 'moment';
import _, { clone, entries, remove } from 'lodash';

type MeterFlow = 'Generation' | 'Consumption';

type Window = {
  consumption: number;
  generation: number;
  batteryCharge: number;
  atMaxCharge: boolean;
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
        batteryCharge: 0,
        atMaxCharge: false
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

      const genThenConsume = false;
      let finalGeneration: number = 0, finalConsumption: number = 0, finalBattery: number = 0;
      if (genThenConsume) {
        const { updatedChargePostGen, updatedGeneration } = addGeneration({ currentBatteryCharge, maxBatterySize, generation: window.generation });
        const { updatedChargePostCons, updatedConsumption } = removeConsumption({ currentBatteryCharge: updatedChargePostGen, consumption: window.consumption });

        finalGeneration = updatedGeneration;
        finalConsumption = updatedConsumption;
        finalBattery = updatedChargePostCons;
      } else {
        const { updatedChargePostCons, updatedConsumption } = removeConsumption({ currentBatteryCharge, consumption: window.consumption });
        const { updatedChargePostGen, updatedGeneration } = addGeneration({ currentBatteryCharge: updatedChargePostCons, maxBatterySize, generation: window.generation });

        finalGeneration = updatedGeneration;
        finalConsumption = updatedConsumption;
        finalBattery = updatedChargePostGen;
      }

      currentBatteryCharge = finalBattery;
      result.timeWindows[windowIndex] = {
        consumption: finalConsumption,
        generation: finalGeneration,
        batteryCharge: finalBattery,
        atMaxCharge: finalBattery >= maxBatterySize - 0.005
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

  battery: BatteryResults;
};

type AggregateResult = {
  consumedEnergy: number;
  consumptionCost: number;
  generatedEnergy: number;
  generationEarnings: number;
}

type CostResults = {
  perMonth: { [month: string]: AggregateResult };
  perYear: { [year: string]: AggregateResult };
};

type BatteryAggregate = {
  /**
   * Measured in kWh
   */
   totalBatteryOutput: number;

   /**
    * The count of the number of days in which the battery reached 100% at least once.
    */
   timesReachedFullBatteryAtLeastOnceInTheDay: number;
};

type BatteryResults = {
  perMonth: { [month: string]: BatteryAggregate },
  perYear: { [year: string]: BatteryAggregate }
}

function aggregateCosts(monthEntries: Array<MeterEntry>, costSettings: CostSettings): AggregateResult {
  let consumptionCost = 0;
  let generationEarnings = 0;
  let consumedEnergy = 0;
  let generatedEnergy = 0;

  monthEntries.forEach(entry => {
    for (let hour = 0; hour < 24; hour++) {
      for(let minute = 0; minute < 60; minute += 30) {
        const windowIndex = calIndex({ hour, minute });

        const timeWindow = entry.timeWindows[windowIndex];
        consumedEnergy += timeWindow.consumption;
        generatedEnergy += timeWindow.generation;
        consumptionCost += timeWindow.consumption * costSettings.costPerHour[windowIndex];
        generationEarnings += timeWindow.generation * costSettings.feedInTarif;
      }
    }
  });

  return {
    consumptionCost,
    generationEarnings,
    consumedEnergy,
    generatedEnergy
  };
}

function aggregateBattery(meterEntries: Array<MeterEntry>): BatteryAggregate {
  let totalBatteryOutput = 0;
  let timesReachedFullBatteryAtLeastOnceInTheDay = 0;
  let prevBatteryCharge = 0;

  meterEntries.forEach(entry => {
    let reachedBatteryFullToday = false;
    for (let hour = 0; hour < 24; hour++) {
      for(let minute = 0; minute < 60; minute += 30) {
        const windowIndex = calIndex({ hour, minute });

        const timeWindow = entry.timeWindows[windowIndex];
        if (timeWindow.atMaxCharge) {
          reachedBatteryFullToday = true;
        }
        const chargeDelta = timeWindow.batteryCharge - prevBatteryCharge;
        if (chargeDelta > 0) {
          totalBatteryOutput += chargeDelta;
        }
        prevBatteryCharge = timeWindow.batteryCharge;
      }
    }
    timesReachedFullBatteryAtLeastOnceInTheDay += reachedBatteryFullToday ? 1 : 0;
  });

  return {
    totalBatteryOutput,
    timesReachedFullBatteryAtLeastOnceInTheDay
  };
}

function calculateStatistics(meterEntries: Array<MeterEntry>, costSettings: CostSettings): SimulationResults {
  const entriesByMonth = _.groupBy(meterEntries, entry => entry.date.format('YYYY-MM'));
  const perMonth = _.mapValues(entriesByMonth, entries => aggregateCosts(entries, costSettings));
  const batteryPerMonth = _.mapValues(entriesByMonth, entries => aggregateBattery(entries));

  const entriesByYear = _.groupBy(meterEntries, entry => entry.date.format('YYYY'));
  const perYear = _.mapValues(entriesByYear, entries => aggregateCosts(entries, costSettings));
  const batteryPerYear = _.mapValues(entriesByYear, entries => aggregateBattery(entries));

  return {
    cost: {
      perMonth,
      perYear
    },
    battery: {
      perMonth: batteryPerMonth,
      perYear: batteryPerYear
    }
  };
}

function printStatistics(title: string, stats: SimulationResults): void {
  console.log(`## Results: ${title}`);
  console.log('');
  console.log('Per Month');
  for (const month in stats.cost.perMonth) {
    if (Object.prototype.hasOwnProperty.call(stats.cost.perMonth, month)) {
      const monthBattery = stats.battery.perMonth[month];
      const monthCosts = stats.cost.perMonth[month];
      const dollarsConsumed = monthCosts.consumptionCost / 100.0;
      const dollarsGenerated = monthCosts.generationEarnings / 100.0;
      const costInDollars = dollarsConsumed - dollarsGenerated;
      console.log(`${month}: $${costInDollars.toFixed(2)} (${monthCosts.consumedEnergy.toFixed(2)}kWh consumed ($${dollarsConsumed.toFixed(2)}) - ${monthCosts.generatedEnergy.toFixed(2)}kWh generated ($${dollarsGenerated.toFixed(2)})) [${monthBattery.timesReachedFullBatteryAtLeastOnceInTheDay} days reached max battery]`);
    }
  }
  console.log('');
  console.log('Per Year');
  for (const year in stats.cost.perYear) {
    if (Object.prototype.hasOwnProperty.call(stats.cost.perYear, year)) {
      const monthCosts = stats.cost.perYear[year];
      const dollarsConsumed = monthCosts.consumptionCost / 100.0;
      const dollarsGenerated = monthCosts.generationEarnings / 100.0;
      const costInDollars = dollarsConsumed - dollarsGenerated;
      console.log(`${year}: $${costInDollars.toFixed(2)} (${monthCosts.consumedEnergy.toFixed(2)}kWh consumed ($${dollarsConsumed.toFixed(2)}) - ${monthCosts.generatedEnergy.toFixed(2)}kWh generated ($${dollarsGenerated.toFixed(2)}))`);
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

      const higherDiff = (higherCosts.consumptionCost - higherCosts.generationEarnings) / 100;
      const lowerDiff = (lowerCosts.consumptionCost - lowerCosts.generationEarnings) / 100;
      console.log(`${month}: $${(higherDiff - lowerDiff).toFixed(2)} savings ($${higherDiff.toFixed(2)} - $${lowerDiff.toFixed(2)})`);
    }
  }
  console.log('');
  console.log('Per year');
  for (const year in higher.cost.perYear) {
    if (Object.prototype.hasOwnProperty.call(higher.cost.perYear, year)) {
      const higherCosts = higher.cost.perYear[year];
      const lowerCosts = lower.cost.perYear[year];

      const higherDiff = (higherCosts.consumptionCost - higherCosts.generationEarnings) / 100;
      const lowerDiff = (lowerCosts.consumptionCost - lowerCosts.generationEarnings) / 100;
      console.log(`${year}: $${((higherDiff - lowerDiff).toFixed(2))} savings ($${higherDiff.toFixed(2)} - $${lowerDiff.toFixed(2)})`);
    }
  }
  console.log('');
}

const POWERSHOP_FEED_IN_TARIF = 5; // Standard powershop feed-in rate
const POWERSHOP_ENERGY_COST = 25.25; // Standard powershop energy price

// https://www.energymadeeasy.gov.au/plan?id=RED181320MRE7&postcode=2154
function getRedSaverPlan(): CostSettings {
  let costPerHour: CostPerHour = {};

  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {
      const windowIndex = calIndex({ hour, minute });

      if (hour >= 16 && hour < 20) {
        costPerHour[windowIndex] = 34.32;
      } else {
        costPerHour[windowIndex] = 22.86;
      }
    }
  }

  return {
    feedInTarif: 7,
    costPerHour
  }
}

// https://www.energymadeeasy.gov.au/plan?id=ALI463712MRE3&postcode=2154
function getAlintaHomeDealPlan(): CostSettings {
  let costPerHour: CostPerHour = {};

  for (let hour = 0; hour < 24; hour++) {
    for(let minute = 0; minute < 60; minute += 30) {
      const windowIndex = calIndex({ hour, minute });

      const offPeak = 19.53;
      const shoulder = 29.56;
      const peak = 34.56;

      if (hour < 7) {
        costPerHour[windowIndex] = offPeak;
      } else if (hour < 13) {
        costPerHour[windowIndex] = shoulder;
      } else if (hour < 20) {
        costPerHour[windowIndex] = peak;
      } else if (hour < 22) {
        costPerHour[windowIndex] = shoulder;
      } else {
        costPerHour[windowIndex] = offPeak;
      }
    }
  }

  return {
    feedInTarif: 6.7,
    costPerHour
  }
}

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

// https://www.energymadeeasy.gov.au/plan?id=ORI431078MRE2&postcode=2154
function getOriginPlan(): CostSettings {
  return {
    feedInTarif: 5,
    costPerHour: constantPerHourCost(29.24)
  }
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

    const powershopNoBatteryStatistics = calculateStatistics(noBatteryResults, {
      feedInTarif: POWERSHOP_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(POWERSHOP_ENERGY_COST)
    });
    const powershopOneBatteryStatistics = calculateStatistics(oneBatteryResults, {
      feedInTarif: POWERSHOP_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(POWERSHOP_ENERGY_COST)
    });
    const powershopTwoBatteryStatistics = calculateStatistics(twoBatteryResults, {
      feedInTarif: POWERSHOP_FEED_IN_TARIF,
      costPerHour: constantPerHourCost(POWERSHOP_ENERGY_COST)
    });

    const redSaverPlan = getRedSaverPlan();
    const redSaverNoBatteryStatistics = calculateStatistics(noBatteryResults, redSaverPlan);
    const redSaverOneBatteryStatistics = calculateStatistics(oneBatteryResults, redSaverPlan);
    const redSaverTwoBatteryStatistics = calculateStatistics(twoBatteryResults, redSaverPlan);

    const alintaPlan = getAlintaHomeDealPlan();
    const alintaNoBatteryStatistics = calculateStatistics(noBatteryResults, alintaPlan);
    const alintaOneBatteryStatistics = calculateStatistics(oneBatteryResults, alintaPlan);
    const alintaTwoBatteryStatistics = calculateStatistics(twoBatteryResults, alintaPlan);

    const originPlan = getOriginPlan();
    const originNoBatteryStatistics = calculateStatistics(noBatteryResults, originPlan);
    const originOneBatteryStatistics = calculateStatistics(oneBatteryResults, originPlan);
    const originTwoBatteryStatistics = calculateStatistics(twoBatteryResults, originPlan);


    //console.log(JSON.stringify(oneBatteryResults, null, 2));

    printStatistics('Powershop No Battery', powershopNoBatteryStatistics);
    printStatistics('Powershop One Battery', powershopOneBatteryStatistics);
    printStatistics('Powershop Two Batteries', powershopTwoBatteryStatistics);
    printStatistics('Red Saver No Battery', redSaverNoBatteryStatistics);
    printStatistics('Red Saver One Battery', redSaverOneBatteryStatistics);
    printStatistics('Red Saver Two Batteries', redSaverTwoBatteryStatistics);
    printStatistics('Alinta HomeDeal No Battery', alintaNoBatteryStatistics);
    printStatistics('Alinta HomeDeal One Battery', alintaOneBatteryStatistics);
    printStatistics('Alinta HomeDeal Two Batteries', alintaTwoBatteryStatistics);
    printStatistics('Origin HomeDeal No Battery', originNoBatteryStatistics);
    printStatistics('Origin HomeDeal One Battery', originOneBatteryStatistics);
    printStatistics('Origin HomeDeal Two Batteries', originTwoBatteryStatistics);

    printStatsComparison('Powershop - No to One Battery', powershopNoBatteryStatistics, powershopOneBatteryStatistics);
    printStatsComparison('Powershop - No to Two Battery', powershopNoBatteryStatistics, powershopTwoBatteryStatistics);
    printStatsComparison('Powershop - One to Two Battery', powershopOneBatteryStatistics, powershopTwoBatteryStatistics);

    printStatsComparison('Powershop No Battery - Red Saver No Battery', powershopNoBatteryStatistics, redSaverNoBatteryStatistics);
    printStatsComparison('Powershop No Battery - Red Saver One Battery', powershopNoBatteryStatistics, redSaverOneBatteryStatistics);
    printStatsComparison('Powershop One Battery - Red Saver One Battery', powershopOneBatteryStatistics, redSaverOneBatteryStatistics);
    printStatsComparison('Red Saver One Battery - Red Saver Two Battery', redSaverOneBatteryStatistics, redSaverTwoBatteryStatistics);

    printStatsComparison('Powershop No Battery - Alinta One Battery', powershopNoBatteryStatistics, alintaOneBatteryStatistics);
    printStatsComparison('Alinta One Battery - Alinta Two Battery', alintaOneBatteryStatistics, alintaTwoBatteryStatistics);

    printStatsComparison('Powershop No Battery - Origin One Battery', powershopNoBatteryStatistics, originOneBatteryStatistics);
    printStatsComparison('Origin One Battery - Origin Two Battery', originOneBatteryStatistics, originTwoBatteryStatistics);

    // Scenarios to simulate
    // No battery (current state)
    // 13.5kWh (One powerwall)
    // 27kWh (Two Powerwalls)
    // Then vary with different energy plans, one time of use and one consistent usage.
    // Some plans vary with how much power has been consumed over the month

  });
}

main();