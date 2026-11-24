package com.admin.service;

import com.admin.common.dto.DnsAccountDto;
import com.admin.common.dto.DnsPointDto;
import com.admin.common.dto.DnsRecordDto;
import com.admin.common.lang.R;
import com.admin.entity.CfAccount;
import com.baomidou.mybatisplus.extension.service.IService;

/**
 * <p>
 * DNS 管理服务(Cloudflare)
 * </p>
 *
 * 面板直连 Cloudflare API 管域名解析。token 只有两种状态:前端提交的明文(一次性)、
 * 库里/日志里的密文;本服务的任何返回值都不带 token 明文。
 *
 * @since 2026-11-25
 */
public interface DnsService extends IService<CfAccount> {

    /** 列出已保存的账号(带掩码,不含 token 明文) */
    R listAccounts();

    /** 新增/更新账号;保存前先调 Cloudflare 验证 token */
    R saveAccount(DnsAccountDto dnsAccountDto);

    /** 删除账号 */
    R deleteAccount(Long id);

    /** 列出该账号下所有域名(zone) */
    R listZones(Long accountId);

    /** 列出某个域名下的解析记录 */
    R listRecords(Long accountId, String zoneId);

    /** 新增(id 为空)或修改(id 有值)一条解析记录 */
    R saveRecord(DnsRecordDto dnsRecordDto);

    /** 删除一条解析记录 */
    R deleteRecord(Long accountId, String zoneId, String recordId);

    /** 一键指向:把某个域名的 A 记录改成目标 IP(没有就新建) */
    R pointRecord(DnsPointDto dnsPointDto);
}
