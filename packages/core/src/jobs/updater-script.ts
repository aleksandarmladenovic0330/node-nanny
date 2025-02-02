import axios from 'axios';
import { FilterQuery } from 'mongoose';

import { ChainsModel, OraclesModel, NodesModel, IChain, IOracle } from '../models';
import { Service as AutomationService } from '../services/automation';
import { getTimestamp } from '../utils';

import chain_data from "../data/chain.json";

interface IChainsAndOraclesResponse {
  chains: IChain[];
  oracles: IOracle[];
}

interface ICurrentChainsAndOraclesResponse {
  currentChains: string[];
}

/* ----- Script Runs Every hour ----- */
export const updaterScript = async () => {
  const nodeNannysBirthday = new Date('2022-02-14').toISOString();

  /* ----- 1) Get newest local Chain and Oracle records' timestamps ---- */
  console.log('Initiating ⛓️ Chains & 🔮 Oracles updater ...');
  let latestChain: string, latestOracle: string;

  if (await ChainsModel.exists({})) {
    const [{ updatedAt }] = await ChainsModel.find({})
      .sort({ updatedAt: -1 })
      .limit(1)
      .select('updatedAt')
      .exec();
    latestChain = new Date(updatedAt).toISOString();
    console.log(`⛓️\ Latest chain update is ${latestChain} ...`);
  } else {
    latestChain = nodeNannysBirthday;
    console.log(`⛓️\ No chains found ...`);
  }

  if (await OraclesModel.exists({})) {
    const [{ updatedAt }] = await OraclesModel.find({})
      .sort({ updatedAt: -1 })
      .limit(1)
      .select('updatedAt')
      .exec();
    latestOracle = new Date(updatedAt).toISOString();
    console.log(`🔮 Latest oracle update is ${latestOracle} ...`);
  } else {
    latestOracle = nodeNannysBirthday;
    console.log(`🔮 No oracles found ...`);
  }

  /* ----- 2) Fetch any newer remote Chain and Oracle records from Infrastructure Support Lambda ---- */
  console.log(
    `Fetching with latest chain ${latestChain} & latest oracle ${latestOracle} ...`,
  );
  const {
    data: { chains, oracles },
  } = chain_data;

  if (chains?.length || oracles?.length) {
    console.log(
      `Running updater at ${getTimestamp()}.\nFound ${chains.length} newer chains and ${
        oracles.length
      } newer oracles ...`,
    );

    /* ----- 3) Add newer Chains and Oracles to local database ---- */
    if (chains?.length) {
      for await (const chain of chains) {
        const {
          name,
          type,
          allowance,
          chainId,
          hasOwnEndpoint,
          useOracles,
          responsePath,
          rpc,
          endpoint,
          healthyValue,
        } = chain;

        const sanitizedChain: FilterQuery<IChain> = {};
        Object.entries({
          name,
          type,
          allowance,
          chainId,
          hasOwnEndpoint,
          useOracles,
          responsePath,
          rpc,
          endpoint,
          healthyValue,
        }).forEach(([key, value]) => {
          if (value !== null && value !== undefined) {
            sanitizedChain[key] = value;
          }
        });

        try {
          if (await ChainsModel.exists({ name })) {
            await ChainsModel.updateOne({ name }, sanitizedChain);
          } else {
            await ChainsModel.create(sanitizedChain);
          }
        } catch (error) {
          console.error(`Error updating Chains. Chain: ${name} ${error}`);
          continue;
        }
      }
    }

    if (oracles?.length) {
      for await (const oracle of oracles) {
        const { chain, urls } = oracle;

        try {
          if (await OraclesModel.exists({ chain })) {
            await OraclesModel.updateOne({ chain }, { urls });
          } else {
            await OraclesModel.create({ chain, urls });
          }
        } catch (error) {
          console.error(`Error updating Oracles. Chain: ${chain} ${error}`);
          continue;
        }
      }
    }

    /* If new or updated Chains or Oracles found, restart the monitor */
    await new AutomationService().restartMonitor();
  } else {
    console.log('No new chains or oracles found ...');
  }

  /* ----- 4) Remove Chains and Oracles that no longer exist in prod from local database ---- */
  console.log('Checking all current chains and oracles ...');
  const {
    data: { currentChains },
  } = chain_data;

  const chainsNotInProd = await ChainsModel.find({ name: { $nin: currentChains } });
  const oraclesNotInProd = await OraclesModel.find({ chain: { $nin: currentChains } });

  if (chainsNotInProd?.length) {
    for await (const { _id, name } of chainsNotInProd) {
      const chainHasNode = await NodesModel.exists({ chain: _id });

      if (!chainHasNode) {
        await ChainsModel.deleteOne({ name });

        if (await OraclesModel.exists({ chain: name })) {
          await OraclesModel.deleteOne({ chain: name });
        }
      }
    }
  }

  if (oraclesNotInProd?.length) {
    for await (const { chain } of oraclesNotInProd) {
      const chainForOracle = await ChainsModel.findOne({ name: chain });
      const oracleHasNode = await NodesModel.exists({ chain: chainForOracle?._id });

      if (!oracleHasNode) {
        await OraclesModel.deleteOne({ chain });
      }
    }
  }
};
