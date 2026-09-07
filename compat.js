/**
 * PaxiCosmJS 兼容层 - 补充缺失的 protobuf 编码器
 * 解决 paxi-cosmjs.umd.js 缺少 coins/MsgSend/MsgExecuteContract 等符号的问题
 */
(function() {
  'use strict';

  function encodeVarint(n) {
    const bytes = [];
    n = BigInt(n);
    if (n === 0n) return new Uint8Array([0]);
    while (n > 0n) {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) byte |= 0x80;
      bytes.push(byte);
    }
    return new Uint8Array(bytes);
  }

  function concatBytes(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  function encodeLenDelim(fieldNum, data) {
    const tag = (fieldNum << 3) | 2;
    const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return concatBytes(encodeVarint(tag), encodeVarint(dataBytes.length), dataBytes);
  }

  function encodeVarintField(fieldNum, value) {
    const tag = (fieldNum << 3) | 0;
    return concatBytes(encodeVarint(tag), encodeVarint(value));
  }

  function encodeCoin(denom, amount) {
    return concatBytes(encodeLenDelim(1, denom), encodeLenDelim(2, amount));
  }

  function coins(amount, denom) {
    return [{ denom, amount: String(amount) }];
  }

  const MsgSend = {
    fromPartial(data) { return data; },
    encode(data) {
      const fromAddress = data.fromAddress || data.from_address;
      const toAddress = data.toAddress || data.to_address;
      const parts = [
        encodeLenDelim(1, fromAddress),
        encodeLenDelim(2, toAddress),
      ];
      if (data.amount && data.amount.length > 0) {
        for (const coin of data.amount) {
          parts.push(encodeLenDelim(3, encodeCoin(coin.denom, coin.amount)));
        }
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const MsgExecuteContract = {
    fromPartial(data) { return data; },
    encode(data) {
      const sender = data.sender || data.sender_address;
      const contract = data.contract || data.contract_addr;
      const msg = data.msg || new Uint8Array();
      const parts = [
        encodeLenDelim(1, sender),
        encodeLenDelim(2, contract),
        encodeLenDelim(3, msg),
      ];
      if (data.funds && data.funds.length > 0) {
        for (const coin of data.funds) {
          parts.push(encodeLenDelim(5, encodeCoin(coin.denom, coin.amount)));
        }
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const MsgInstantiateContract = {
    fromPartial(data) { return data; },
    encode(data) {
      const parts = [
        encodeLenDelim(1, data.sender),
        encodeLenDelim(2, data.admin || ''),
        encodeVarintField(3, data.codeId || data.code_id || 0),
        encodeLenDelim(4, data.label || ''),
        encodeLenDelim(5, data.msg || new Uint8Array()),
      ];
      if (data.funds && data.funds.length > 0) {
        for (const coin of data.funds) {
          parts.push(encodeLenDelim(6, encodeCoin(coin.denom, coin.amount)));
        }
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const PubKey = {
    encode(data) {
      return { finish: () => encodeLenDelim(1, data.key) };
    },
  };

  const AnyEncode = {
    encode(data) {
      return {
        finish: () => concatBytes(
          encodeLenDelim(1, data.typeUrl),
          encodeLenDelim(2, data.value),
        ),
      };
    },
  };

  const GenericAuthorization = {
    fromPartial(data) { return data; },
    encode(data) {
      return { finish: () => encodeLenDelim(1, data.msg) };
    },
  };

  const Timestamp = {
    fromPartial(data) { return data; },
    encode(data) {
      return {
        finish: () => concatBytes(
          encodeVarintField(1, data.seconds),
          encodeVarintField(2, data.nanos || 0),
        ),
      };
    },
  };

  const Grant = {
    fromPartial(data) { return data; },
    encode(data) {
      const authBytes = AnyEncode.encode(data.authorization).finish();
      const expBytes = Timestamp.encode(data.expiration).finish();
      return {
        finish: () => concatBytes(
          encodeLenDelim(1, authBytes),
          encodeLenDelim(2, expBytes),
        ),
      };
    },
  };

  const MsgGrant = {
    fromPartial(data) { return data; },
    encode(data) {
      const grantBytes = Grant.encode(data.grant).finish();
      return {
        finish: () => concatBytes(
          encodeLenDelim(1, data.granter),
          encodeLenDelim(2, data.grantee),
          encodeLenDelim(3, grantBytes),
        ),
      };
    },
  };

  const MsgExec = {
    fromPartial(data) { return data; },
    encode(data) {
      const parts = [encodeLenDelim(1, data.grantee)];
      if (data.msgs) {
        for (const msg of data.msgs) {
          parts.push(encodeLenDelim(2, AnyEncode.encode(msg).finish()));
        }
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const MsgRevoke = {
    fromPartial(data) { return data; },
    encode(data) {
      return {
        finish: () => concatBytes(
          encodeLenDelim(1, data.granter),
          encodeLenDelim(2, data.grantee),
          encodeLenDelim(3, data.msgTypeUrl),
        ),
      };
    },
  };

  const MsgBeginRedelegate = {
    fromPartial(data) { return data; },
    encode(data) {
      const delegatorAddress = data.delegator_address || data.delegatorAddress;
      const validatorSrcAddress = data.validator_src_address || data.validatorSrcAddress;
      const validatorDstAddress = data.validator_dst_address || data.validatorDstAddress;
      const parts = [
        encodeLenDelim(1, delegatorAddress),
        encodeLenDelim(2, validatorSrcAddress),
        encodeLenDelim(3, validatorDstAddress),
      ];
      if (data.amount) {
        parts.push(encodeLenDelim(4, encodeCoin(data.amount.denom, data.amount.amount)));
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const TextProposal = {
    fromPartial(data) { return data; },
    encode(data) {
      return {
        finish: () => concatBytes(
          encodeLenDelim(1, data.title || ''),
          encodeLenDelim(2, data.description || ''),
        ),
      };
    },
  };

  const ParamChange = {
    fromPartial(data) { return data; },
    encode(data) {
      const parts = [];
      if (data.subspace) parts.push(encodeLenDelim(1, data.subspace));
      if (data.key) parts.push(encodeLenDelim(2, data.key));
      if (data.value != null) parts.push(encodeLenDelim(3, String(data.value)));
      return { finish: () => concatBytes(...parts) };
    },
  };

  const ParameterChangeProposal = {
    fromPartial(data) { return data; },
    encode(data) {
      const parts = [
        encodeLenDelim(1, data.title || ''),
        encodeLenDelim(2, data.description || ''),
      ];
      if (data.changes && Array.isArray(data.changes)) {
        for (const c of data.changes) {
          parts.push(encodeLenDelim(3, ParamChange.encode(c).finish()));
        }
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  const MsgSubmitProposal = {
    fromPartial(data) { return data; },
    encode(data) {
      const parts = [];
      if (data.content) {
        parts.push(encodeLenDelim(1, AnyEncode.encode(data.content).finish()));
      }
      if (data.initial_deposit || data.initialDeposit) {
        const deposit = data.initial_deposit || data.initialDeposit || [];
        for (const coin of deposit) {
          parts.push(encodeLenDelim(2, encodeCoin(coin.denom, coin.amount)));
        }
      }
      if (data.proposer) {
        parts.push(encodeLenDelim(3, data.proposer));
      }
      return { finish: () => concatBytes(...parts) };
    },
  };

  /**
   * 安全的 base64 编码（循环拼接，避免展开运算符栈溢出）
   * @param {Uint8Array|number[]} bytes
   * @returns {string}
   */
  function toBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < arr.length; i += chunk) {
      binary += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + chunk, arr.length)));
    }
    return btoa(binary);
  }

  function applyCompat() {
    if (typeof window.PaxiCosmJS === 'undefined') {
      console.error('[Compat] PaxiCosmJS 未加载');
      return;
    }

    const supplement = {
      MsgSend,
      MsgExecuteContract,
      MsgInstantiateContract,
      PubKey,
      coins,
      GenericAuthorization,
      Timestamp,
      Grant,
      MsgGrant,
      MsgExec,
      MsgRevoke,
      MsgBeginRedelegate,
      TextProposal,
      ParamChange,
      ParameterChangeProposal,
      MsgSubmitProposal,
      toBase64,
    };

    let added = [];
    for (const [name, impl] of Object.entries(supplement)) {
      if (typeof window.PaxiCosmJS[name] === 'undefined') {
        window.PaxiCosmJS[name] = impl;
        added.push(name);
      }
    }

    if (added.length > 0) {
      console.log('[Compat] 已补充缺失的类:', added.join(', '));
    } else {
      console.log('[Compat] PaxiCosmJS SDK 完整，无需补充');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyCompat);
  } else {
    applyCompat();
  }
})();
